const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Stockage en mémoire des parties
const parties = {};

// Génère un code aléatoire ex: "XK-47"
function genCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code.slice(0, 2) + '-' + code.slice(2);
}

// Assigne les cibles aléatoirement (chaîne circulaire)
function assignerCibles(equipes) {
  const ids = Object.keys(equipes);
  const shuffled = ids.sort(() => Math.random() - 0.5);
  const cibles = {};
  for (let i = 0; i < shuffled.length; i++) {
    cibles[shuffled[i]] = shuffled[(i + 1) % shuffled.length];
  }
  return cibles;
}

io.on('connection', (socket) => {
  console.log('Connexion :', socket.id);

  // ─── CRÉER UNE PARTIE ───
  socket.on('creer_partie', ({ prenom, nomEquipe, prenomBinome }) => {
    const codePartie = genCode();
    const codeEquipe = genCode(4).replace('-', '');

    parties[codePartie] = {
      code: codePartie,
      statut: 'attente', // attente | countdown | jeu
      equipes: {
        [codeEquipe]: {
          nom: nomEquipe,
          joueurs: [{ id: socket.id, prenom, pret: false }],
          codeEquipe,
          pret: false,
        }
      }
    };

    socket.join(codePartie);
    socket.join(codeEquipe);
    socket.data = { codePartie, codeEquipe, prenom };

    socket.emit('partie_creee', { codePartie, codeEquipe, nomEquipe });
    io.to(codePartie).emit('update_partie', parties[codePartie]);
    console.log(`Partie créée : ${codePartie}`);
  });

  // ─── REJOINDRE UNE PARTIE ───
  socket.on('rejoindre_partie', ({ prenom, codePartie }) => {
    const partie = parties[codePartie];
    if (!partie) return socket.emit('erreur', 'Partie introuvable');
    if (partie.statut !== 'attente') return socket.emit('erreur', 'Partie déjà lancée');

    const codeEquipe = genCode(4).replace('-', '');
    partie.equipes[codeEquipe] = {
      nom: `Équipe de ${prenom}`,
      joueurs: [{ id: socket.id, prenom, pret: false }],
      codeEquipe,
      pret: false,
    };

    socket.join(codePartie);
    socket.join(codeEquipe);
    socket.data = { codePartie, codeEquipe, prenom };

    socket.emit('rejoint_partie', { codePartie, codeEquipe });
    io.to(codePartie).emit('update_partie', parties[codePartie]);
  });

  // ─── REJOINDRE UNE ÉQUIPE (binôme) ───
  socket.on('rejoindre_equipe', ({ prenom, codePartie, codeEquipe }) => {
    const partie = parties[codePartie];
    if (!partie) return socket.emit('erreur', 'Partie introuvable');
    const equipe = partie.equipes[codeEquipe];
    if (!equipe) return socket.emit('erreur', 'Équipe introuvable');
    if (equipe.joueurs.length >= 2) return socket.emit('erreur', 'Équipe déjà complète');

    equipe.joueurs.push({ id: socket.id, prenom, pret: false });

    socket.join(codePartie);
    socket.join(codeEquipe);
    socket.data = { codePartie, codeEquipe, prenom };

    socket.emit('rejoint_equipe', { codePartie, codeEquipe, nomEquipe: equipe.nom });
    io.to(codePartie).emit('update_partie', parties[codePartie]);
  });

  // ─── MARQUER PRÊT ───
  socket.on('je_suis_pret', () => {
    const { codePartie, codeEquipe } = socket.data || {};
    const partie = parties[codePartie];
    if (!partie) return;

    const equipe = partie.equipes[codeEquipe];
    if (!equipe) return;

    // Marquer le joueur comme prêt
    equipe.joueurs.forEach(j => { if (j.id === socket.id) j.pret = true; });

    // Équipe prête si tous ses joueurs sont prêts
    equipe.pret = equipe.joueurs.every(j => j.pret);

    io.to(codePartie).emit('update_partie', parties[codePartie]);

    // Si toutes les équipes sont prêtes → countdown
    const toutesPretes = Object.values(partie.equipes).every(e => e.pret);
    if (toutesPretes && Object.keys(partie.equipes).length >= 2) {
      partie.statut = 'countdown';
      io.to(codePartie).emit('countdown_start', { duree: 30 });

      // Après 30s → lancer le jeu
      setTimeout(() => {
        if (!parties[codePartie]) return;
        partie.statut = 'jeu';
        const cibles = assignerCibles(partie.equipes);

        // Envoyer à chaque équipe sa cible
        Object.entries(cibles).forEach(([idEquipe, idCible]) => {
          const equipeChasseur = partie.equipes[idEquipe];
          const equipeCible = partie.equipes[idCible];
          io.to(idEquipe).emit('jeu_lance', {
            cible: {
              codeEquipe: idCible,
              nom: equipeCible.nom,
              joueurs: equipeCible.joueurs.map(j => j.prenom)
            }
          });
        });

        io.to(codePartie).emit('update_partie', parties[codePartie]);
      }, 30000);
    }
  });

  // ─── ÉLIMINATION ───
  socket.on('eliminer_cible', ({ codePartie, codeEquipeCible }) => {
    const partie = parties[codePartie];
    if (!partie) return;

    const equipe = partie.equipes[codeEquipeCible];
    if (!equipe) return;

    equipe.eliminee = true;
    io.to(codePartie).emit('equipe_eliminee', {
      nomEquipe: equipe.nom,
      eliminePar: partie.equipes[socket.data.codeEquipe]?.nom
    });

    io.to(codePartie).emit('update_partie', parties[codePartie]);

    // Vérifier s'il reste une seule équipe
    const restantes = Object.values(partie.equipes).filter(e => !e.eliminee);
    if (restantes.length === 1) {
      io.to(codePartie).emit('fin_partie', { gagnant: restantes[0].nom });
    }
  });

  // ─── POSITION GPS ───
  socket.on('update_position', ({ codePartie, codeEquipe, lat, lng }) => {
    const partie = parties[codePartie];
    if (!partie) return;
    if (partie.equipes[codeEquipe]) {
      partie.equipes[codeEquipe].position = { lat, lng };
    }
    // Envoyer les positions de toutes les équipes à tous
    const positions = {};
    Object.entries(partie.equipes).forEach(([id, eq]) => {
      if (eq.position) positions[id] = { lat: eq.position.lat, lng: eq.position.lng, nom: eq.nom };
    });
    io.to(codePartie).emit('update_positions', positions);
  });

  // ─── DÉCONNEXION ───
  socket.on('disconnect', () => {
    const { codePartie, codeEquipe, prenom } = socket.data || {};
    if (!codePartie || !parties[codePartie]) return;
    const equipe = parties[codePartie]?.equipes[codeEquipe];
    if (equipe) {
      equipe.joueurs = equipe.joueurs.filter(j => j.id !== socket.id);
      if (equipe.joueurs.length === 0) delete parties[codePartie].equipes[codeEquipe];
    }
    io.to(codePartie).emit('update_partie', parties[codePartie]);
    console.log(`Déconnexion : ${prenom}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
