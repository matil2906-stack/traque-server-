const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const parties = {};

function genCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code.slice(0, 2) + '-' + code.slice(2);
}

function assignerCibles(equipes) {
  const ids = Object.keys(equipes).filter(id => !equipes[id].eliminee);
  const shuffled = ids.sort(() => Math.random() - 0.5);
  const cibles = {};
  for (let i = 0; i < shuffled.length; i++) {
    cibles[shuffled[i]] = shuffled[(i + 1) % shuffled.length];
  }
  return cibles;
}

const BONUS_LIST = ['bouclier', 'revelation', 'brouillard', 'changement'];
function bonusAleatoire() { return BONUS_LIST[Math.floor(Math.random() * BONUS_LIST.length)]; }

function creerEquipe(socketId, prenom, nom, codeEquipe) {
  return {
    nom, codeEquipe,
    joueurs: [{ id: socketId, prenom, pret: false, capture: false }],
    pret: false, eliminee: false,
    bonus: bonusAleatoire(),
    bouclierActif: false, brouillardActif: false,
    position: null,
  };
}

function tousCaptures(equipe) {
  return equipe.joueurs.every(j => j.capture);
}

function equipeComplete(partie) {
  const restantes = Object.values(partie.equipes).filter(e => !e.eliminee);
  return restantes.length === 1;
}

io.on('connection', (socket) => {

  // ─── CRÉER UNE PARTIE ───
  socket.on('creer_partie', ({ prenom, nomEquipe }) => {
    const codePartie = genCode();
    const codeEquipe = genCode(4).replace('-', '');
    parties[codePartie] = {
      code: codePartie, statut: 'attente', cibles: {},
      equipes: { [codeEquipe]: creerEquipe(socket.id, prenom, nomEquipe, codeEquipe) }
    };
    socket.join(codePartie); socket.join(codeEquipe);
    socket.data = { codePartie, codeEquipe, prenom };
    socket.emit('partie_creee', { codePartie, codeEquipe, nomEquipe });
    io.to(codePartie).emit('update_partie', parties[codePartie]);
  });

  // ─── REJOINDRE UNE PARTIE ───
  socket.on('rejoindre_partie', ({ prenom, codePartie }) => {
    const partie = parties[codePartie];
    if (!partie) return socket.emit('erreur', 'Partie introuvable');
    if (partie.statut !== 'attente') return socket.emit('erreur', 'Partie déjà lancée');
    const codeEquipe = genCode(4).replace('-', '');
    partie.equipes[codeEquipe] = creerEquipe(socket.id, prenom, `Équipe de ${prenom}`, codeEquipe);
    socket.join(codePartie); socket.join(codeEquipe);
    socket.data = { codePartie, codeEquipe, prenom };
    socket.emit('rejoint_partie', { codePartie, codeEquipe });
    io.to(codePartie).emit('update_partie', parties[codePartie]);
  });

  // ─── REJOINDRE UNE ÉQUIPE (binôme ou trio) ───
  socket.on('rejoindre_equipe', ({ prenom, codePartie, codeEquipe }) => {
    const partie = parties[codePartie];
    if (!partie) return socket.emit('erreur', 'Partie introuvable');
    const equipe = partie.equipes[codeEquipe];
    if (!equipe) return socket.emit('erreur', 'Équipe introuvable');
    if (equipe.joueurs.filter(j => !j.capture).length >= 3) return socket.emit('erreur', 'Équipe déjà complète (max 3)');

    equipe.joueurs.push({ id: socket.id, prenom, pret: false, capture: false });
    socket.join(codePartie); socket.join(codeEquipe);
    socket.data = { codePartie, codeEquipe, prenom };

    // Si la partie est déjà lancée → joueur solo qui rejoint un trio
    if (partie.statut === 'jeu') {
      socket.emit('rejoint_equipe_en_cours', {
        codePartie, codeEquipe, nomEquipe: equipe.nom,
        cible: partie.cibles[codeEquipe] ? {
          codeEquipe: partie.cibles[codeEquipe],
          nom: partie.equipes[partie.cibles[codeEquipe]]?.nom,
          joueurs: partie.equipes[partie.cibles[codeEquipe]]?.joueurs.map(j => j.prenom)
        } : null,
        bonus: equipe.bonus
      });
    } else {
      socket.emit('rejoint_equipe', { codePartie, codeEquipe, nomEquipe: equipe.nom });
    }
    io.to(codePartie).emit('update_partie', parties[codePartie]);
  });

  // ─── MARQUER PRÊT ───
  socket.on('je_suis_pret', () => {
    const { codePartie, codeEquipe } = socket.data || {};
    const partie = parties[codePartie];
    if (!partie) return;
    const equipe = partie.equipes[codeEquipe];
    if (!equipe) return;

    equipe.joueurs.forEach(j => { if (j.id === socket.id) j.pret = true; });
    equipe.pret = equipe.joueurs.every(j => j.pret);
    io.to(codePartie).emit('update_partie', parties[codePartie]);

    const toutesPretes = Object.values(partie.equipes).every(e => e.pret);
    if (toutesPretes && Object.keys(partie.equipes).length >= 2) {
      partie.statut = 'countdown';
      io.to(codePartie).emit('countdown_start', { duree: 30 });

      setTimeout(() => {
        if (!parties[codePartie]) return;
        partie.statut = 'jeu';
        io.to(codePartie).emit('jeu_lance_sans_cible');

        // Après 10 min → révéler les cibles
        setTimeout(() => {
          if (!parties[codePartie]) return;
          partie.cibles = assignerCibles(partie.equipes);
          Object.entries(partie.cibles).forEach(([idEquipe, idCible]) => {
            const eq = partie.equipes[idEquipe];
            const cibleEq = partie.equipes[idCible];
            if (!eq || !cibleEq) return;
            io.to(idEquipe).emit('cible_revelee', {
              cible: { codeEquipe: idCible, nom: cibleEq.nom, joueurs: cibleEq.joueurs.map(j => j.prenom) },
              bonus: eq.bonus
            });
          });
        }, 600000);
      }, 30000);
    }
  });

  // ─── CAPTURER UN JOUEUR ───
  socket.on('capturer_joueur', ({ codePartie, codeEquipeCible, prenomCapture, photo }) => {
    const partie = parties[codePartie];
    if (!partie) return;
    const { codeEquipe } = socket.data || {};
    const equipeCible = partie.equipes[codeEquipeCible];
    const equipeChasseur = partie.equipes[codeEquipe];
    if (!equipeCible || equipeCible.eliminee) return;
    if (partie.cibles[codeEquipe] !== codeEquipeCible) return;
    if (equipeCible.bouclierActif) return socket.emit('erreur_bonus', '🛡️ Cette équipe est protégée !');

    // Marquer le joueur comme capturé
    const joueur = equipeCible.joueurs.find(j => j.prenom === prenomCapture && !j.capture);
    if (!joueur) return socket.emit('erreur', 'Joueur introuvable ou déjà capturé');
    joueur.capture = true;

    // Envoyer la preuve à tout le monde
    io.to(codePartie).emit('joueur_capture', {
      nomEquipe: equipeCible.nom,
      prenomCapture,
      capturePar: equipeChasseur?.nom,
      photo: photo || null,
      restants: equipeCible.joueurs.filter(j => !j.capture).map(j => j.prenom)
    });

    // Est-ce que toute l'équipe est capturée ?
    if (tousCaptures(equipeCible)) {
      // Équipe complètement éliminée
      equipeCible.eliminee = true;

      // Héritage : nouvelle cible = cible de la cible
      const nouvelleCibleId = partie.cibles[codeEquipeCible];
      if (nouvelleCibleId && nouvelleCibleId !== codeEquipe) {
        partie.cibles[codeEquipe] = nouvelleCibleId;
        const nouvelleCibleEq = partie.equipes[nouvelleCibleId];
        if (nouvelleCibleEq) {
          io.to(codeEquipe).emit('nouvelle_cible', {
            cible: { codeEquipe: nouvelleCibleId, nom: nouvelleCibleEq.nom, joueurs: nouvelleCibleEq.joueurs.map(j => j.prenom) }
          });
        }
      }

      // Bonus de la cible transféré si pas utilisé
      const bonusRecupere = equipeCible.bonus;
      if (bonusRecupere) {
        equipeChasseur.bonus = bonusRecupere;
        io.to(codeEquipe).emit('nouveau_bonus', { bonus: bonusRecupere, message: `Bonus récupéré sur ${equipeCible.nom} !` });
      } else {
        const nouveauBonus = bonusAleatoire();
        equipeChasseur.bonus = nouveauBonus;
        io.to(codeEquipe).emit('nouveau_bonus', { bonus: nouveauBonus });
      }

      io.to(codePartie).emit('equipe_eliminee', { nomEquipe: equipeCible.nom, eliminePar: equipeChasseur?.nom, photo });
      io.to(codePartie).emit('update_partie', parties[codePartie]);

      if (equipeComplete(partie)) {
        const gagnant = Object.values(partie.equipes).find(e => !e.eliminee);
        io.to(codePartie).emit('fin_partie', { gagnant: gagnant?.nom });
      }
    } else {
      // Il reste des joueurs dans l'équipe → solo
      const restants = equipeCible.joueurs.filter(j => !j.capture);
      restants.forEach(j => {
        io.to(j.id).emit('binome_capture', {
          prenomCapture,
          message: `${prenomCapture} a été capturé ! Tu es seul, rejoins un groupe ou continue seul !`,
          codePartie,
          equipes: partie.equipes
        });
      });
      io.to(codePartie).emit('update_partie', parties[codePartie]);
    }
  });

  // ─── UTILISER UN BONUS ───
  socket.on('utiliser_bonus', ({ codePartie }) => {
    const { codeEquipe } = socket.data || {};
    const partie = parties[codePartie];
    if (!partie) return;
    const equipe = partie.equipes[codeEquipe];
    if (!equipe || !equipe.bonus) return;

    const bonus = equipe.bonus;
    equipe.bonus = null;

    if (bonus === 'bouclier') {
      equipe.bouclierActif = true;
      io.to(codeEquipe).emit('bonus_active', { bonus, message: '🛡️ Bouclier actif 2 min !' });
      io.to(codePartie).emit('bonus_visible', { nomEquipe: equipe.nom, bonus });
      setTimeout(() => { equipe.bouclierActif = false; io.to(codeEquipe).emit('bouclier_expire'); }, 120000);
    } else if (bonus === 'revelation') {
      const idCible = partie.cibles[codeEquipe];
      const cibleEq = idCible ? partie.equipes[idCible] : null;
      socket.emit('bonus_active', { bonus, message: cibleEq?.position ? '👁️ Position visible 30 sec !' : '👁️ Pas encore de GPS.', position: cibleEq?.position || null });
      io.to(codePartie).emit('bonus_visible', { nomEquipe: equipe.nom, bonus });
    } else if (bonus === 'brouillard') {
      equipe.brouillardActif = true;
      io.to(codeEquipe).emit('bonus_active', { bonus, message: '💨 Brouillard actif 1 min !' });
      io.to(codePartie).emit('bonus_visible', { nomEquipe: equipe.nom, bonus });
      setTimeout(() => { equipe.brouillardActif = false; io.to(codeEquipe).emit('brouillard_expire'); }, 60000);
    } else if (bonus === 'changement') {
      const actives = Object.keys(partie.equipes).filter(id => !partie.equipes[id].eliminee && id !== codeEquipe && id !== partie.cibles[codeEquipe]);
      if (actives.length > 0) {
        const newId = actives[Math.floor(Math.random() * actives.length)];
        partie.cibles[codeEquipe] = newId;
        const newEq = partie.equipes[newId];
        io.to(codeEquipe).emit('bonus_active', { bonus, message: '🔄 Nouvelle cible !' });
        io.to(codeEquipe).emit('nouvelle_cible', { cible: { codeEquipe: newId, nom: newEq.nom, joueurs: newEq.joueurs.map(j => j.prenom) } });
      }
      io.to(codePartie).emit('bonus_visible', { nomEquipe: equipe.nom, bonus });
    }
  });

  // ─── POSITION GPS ───
  socket.on('update_position', ({ codePartie, codeEquipe, lat, lng }) => {
    const partie = parties[codePartie];
    if (!partie) return;
    const eq = partie.equipes[codeEquipe];
    if (eq && !eq.brouillardActif) eq.position = { lat, lng };
    const positions = {};
    Object.entries(partie.equipes).forEach(([id, e]) => {
      if (e.position && !e.brouillardActif && !e.eliminee)
        positions[id] = { lat: e.position.lat, lng: e.position.lng, nom: e.nom };
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
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
