const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const parties = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c.slice(0, 2) + '-' + c.slice(2);
}

function genCodeEquipe() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

const BONUS_LIST = ['bouclier', 'revelation', 'brouillard', 'changement'];
function bonusAlea() { return BONUS_LIST[Math.floor(Math.random() * BONUS_LIST.length)]; }

function assignerCibles(equipes) {
  const ids = Object.keys(equipes).filter(id => !equipes[id].eliminee);
  const shuffled = ids.sort(() => Math.random() - 0.5);
  const cibles = {};
  for (let i = 0; i < shuffled.length; i++) {
    cibles[shuffled[i]] = shuffled[(i + 1) % shuffled.length];
  }
  return cibles;
}

function tousCaptures(eq) { return eq.joueurs.every(j => j.capture); }

io.on('connection', (socket) => {

  // CREER PARTIE
  socket.on('creer_partie', ({ prenom, nomEquipe }) => {
    const codePartie = genCode();
    const codeEquipe = genCodeEquipe();
    parties[codePartie] = {
      code: codePartie, statut: 'attente', cibles: {},
      equipes: {
        [codeEquipe]: {
          nom: nomEquipe, codeEquipe,
          joueurs: [{ id: socket.id, prenom, pret: false, capture: false }],
          pret: false, eliminee: false, bonus: bonusAlea(),
          bouclierActif: false, brouillardActif: false, position: null
        }
      }
    };
    socket.join(codePartie); socket.join(codeEquipe);
    socket.data = { codePartie, codeEquipe, prenom };
    socket.emit('partie_creee', { codePartie, codeEquipe, nomEquipe });
    io.to(codePartie).emit('update_partie', parties[codePartie]);
  });

  // REJOINDRE PARTIE
  socket.on('rejoindre_partie', ({ prenom, codePartie }) => {
    const partie = parties[codePartie];
    if (!partie) return socket.emit('erreur', 'Partie introuvable');
    if (partie.statut !== 'attente') return socket.emit('erreur', 'Partie deja lancee');
    const codeEquipe = genCodeEquipe();
    partie.equipes[codeEquipe] = {
      nom: 'Equipe de ' + prenom, codeEquipe,
      joueurs: [{ id: socket.id, prenom, pret: false, capture: false }],
      pret: false, eliminee: false, bonus: bonusAlea(),
      bouclierActif: false, brouillardActif: false, position: null
    };
    socket.join(codePartie); socket.join(codeEquipe);
    socket.data = { codePartie, codeEquipe, prenom };
    socket.emit('rejoint_partie', { codePartie, codeEquipe });
    io.to(codePartie).emit('update_partie', parties[codePartie]);
  });

  // REJOINDRE EQUIPE (binome ou trio en cours)
  socket.on('rejoindre_equipe', ({ prenom, codePartie, codeEquipe }) => {
    const partie = parties[codePartie];
    if (!partie) return socket.emit('erreur', 'Partie introuvable');
    const equipe = partie.equipes[codeEquipe];
    if (!equipe) return socket.emit('erreur', 'Equipe introuvable');
    if (equipe.joueurs.filter(j => !j.capture).length >= 3) return socket.emit('erreur', 'Equipe pleine');

    equipe.joueurs.push({ id: socket.id, prenom, pret: false, capture: false });
    socket.join(codePartie); socket.join(codeEquipe);
    socket.data = { codePartie, codeEquipe, prenom };

    if (partie.statut === 'jeu') {
      const idCible = partie.cibles[codeEquipe];
      const eqCible = idCible ? partie.equipes[idCible] : null;
      socket.emit('rejoint_en_cours', {
        codePartie, codeEquipe, nomEquipe: equipe.nom,
        cible: eqCible ? { codeEquipe: idCible, nom: eqCible.nom, joueurs: eqCible.joueurs.filter(j=>!j.capture).map(j=>j.prenom) } : null,
        bonus: equipe.bonus
      });
    } else {
      socket.emit('rejoint_equipe', { codePartie, codeEquipe, nomEquipe: equipe.nom });
    }
    io.to(codePartie).emit('update_partie', parties[codePartie]);
  });

  // PRET
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
        io.to(codePartie).emit('jeu_lance');
        // Apres 10 min -> reveler les cibles
        setTimeout(() => {
          if (!parties[codePartie]) return;
          partie.cibles = assignerCibles(partie.equipes);
          Object.entries(partie.cibles).forEach(([idEq, idCible]) => {
            const eq = partie.equipes[idEq];
            const eqCible = partie.equipes[idCible];
            if (!eq || !eqCible) return;
            io.to(idEq).emit('cible_revelee', {
              cible: { codeEquipe: idCible, nom: eqCible.nom, joueurs: eqCible.joueurs.filter(j=>!j.capture).map(j=>j.prenom) },
              bonus: eq.bonus
            });
          });
        }, 600000);
      }, 30000);
    }
  });

  // CAPTURER UN JOUEUR
  socket.on('capturer_joueur', ({ codePartie, codeEquipeCible, prenomCapture, photo }) => {
    const partie = parties[codePartie];
    if (!partie) return;
    const { codeEquipe } = socket.data || {};
    const eqCible = partie.equipes[codeEquipeCible];
    const eqChasseur = partie.equipes[codeEquipe];
    if (!eqCible || eqCible.eliminee) return;
    if (partie.cibles[codeEquipe] !== codeEquipeCible) return;
    if (eqCible.bouclierActif) return socket.emit('erreur_bonus', 'Bouclier actif !');

    const joueur = eqCible.joueurs.find(j => j.prenom === prenomCapture && !j.capture);
    if (!joueur) return;
    joueur.capture = true;

    const restants = eqCible.joueurs.filter(j => !j.capture).map(j => j.prenom);

    io.to(codePartie).emit('joueur_capture', {
      nomEquipe: eqCible.nom, prenomCapture,
      capturePar: eqChasseur?.nom, photo: photo || null, restants
    });

    if (tousCaptures(eqCible)) {
      eqCible.eliminee = true;
      // Heritage de cible
      const nouvelleCibleId = partie.cibles[codeEquipeCible];
      if (nouvelleCibleId && nouvelleCibleId !== codeEquipe) {
        partie.cibles[codeEquipe] = nouvelleCibleId;
        const nouvEqCible = partie.equipes[nouvelleCibleId];
        if (nouvEqCible) {
          io.to(codeEquipe).emit('nouvelle_cible', {
            cible: { codeEquipe: nouvelleCibleId, nom: nouvEqCible.nom, joueurs: nouvEqCible.joueurs.filter(j=>!j.capture).map(j=>j.prenom) }
          });
        }
      }
      // Recuperer le bonus de la cible ou en avoir un nouveau
      const bonusRecup = eqCible.bonus || bonusAlea();
      eqChasseur.bonus = bonusRecup;
      io.to(codeEquipe).emit('nouveau_bonus', { bonus: bonusRecup });
      io.to(codePartie).emit('equipe_eliminee', { nomEquipe: eqCible.nom, eliminePar: eqChasseur?.nom, photo });
      io.to(codePartie).emit('update_partie', parties[codePartie]);
      const restantes = Object.values(partie.equipes).filter(e => !e.eliminee);
      if (restantes.length === 1) io.to(codePartie).emit('fin_partie', { gagnant: restantes[0].nom });
    } else {
      // Solo -> envoyer la liste des equipes
      eqCible.joueurs.filter(j => !j.capture).forEach(j => {
        io.to(j.id).emit('binome_capture', {
          prenomCapture,
          message: prenomCapture + ' a ete capture ! Rejoins un groupe ou continue seul.',
          equipes: partie.equipes
        });
      });
      io.to(codePartie).emit('update_partie', parties[codePartie]);
    }
  });

  // UTILISER BONUS
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
      io.to(codeEquipe).emit('bonus_active', { bonus, message: 'Bouclier actif 2 min !' });
      io.to(codePartie).emit('bonus_visible', { nomEquipe: equipe.nom, bonus });
      setTimeout(() => { equipe.bouclierActif = false; io.to(codeEquipe).emit('bouclier_expire'); }, 120000);
    } else if (bonus === 'revelation') {
      const idCible = partie.cibles[codeEquipe];
      const eqCible = idCible ? partie.equipes[idCible] : null;
      socket.emit('bonus_active', { bonus, message: eqCible?.position ? 'Position visible 30 sec !' : 'Cible sans GPS.', position: eqCible?.position || null });
      io.to(codePartie).emit('bonus_visible', { nomEquipe: equipe.nom, bonus });
    } else if (bonus === 'brouillard') {
      equipe.brouillardActif = true;
      io.to(codeEquipe).emit('bonus_active', { bonus, message: 'Brouillard 1 min ! Invisible.' });
      io.to(codePartie).emit('bonus_visible', { nomEquipe: equipe.nom, bonus });
      setTimeout(() => { equipe.brouillardActif = false; io.to(codeEquipe).emit('brouillard_expire'); }, 60000);
    } else if (bonus === 'changement') {
      const actives = Object.keys(partie.equipes).filter(id => !partie.equipes[id].eliminee && id !== codeEquipe && id !== partie.cibles[codeEquipe]);
      if (actives.length > 0) {
        const newId = actives[Math.floor(Math.random() * actives.length)];
        partie.cibles[codeEquipe] = newId;
        const newEq = partie.equipes[newId];
        io.to(codeEquipe).emit('bonus_active', { bonus, message: 'Nouvelle cible !' });
        io.to(codeEquipe).emit('nouvelle_cible', { cible: { codeEquipe: newId, nom: newEq.nom, joueurs: newEq.joueurs.filter(j=>!j.capture).map(j=>j.prenom) } });
      }
      io.to(codePartie).emit('bonus_visible', { nomEquipe: equipe.nom, bonus });
    }
  });

  // GPS
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

  // DECONNEXION
  socket.on('disconnect', () => {
    const { codePartie, codeEquipe } = socket.data || {};
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
server.listen(PORT, () => console.log('Serveur lance sur le port ' + PORT));
