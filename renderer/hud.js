// Pilot HUD: a small window above CapCut, click-through, fed by the main process.
const $ = id => document.getElementById(id);
const STEPS = [['Fermer', 'Fermeture de CapCut'], ['En tête', 'Placement en tête'], ['Lancer', 'Lancement de CapCut'], ['Ouvrir', 'Ouverture du projet'],
  ['⌘E', 'Ouverture de la fenêtre'], ['Exporter', 'Lancement de l’export'], ['Fichier', 'Export en cours'], ['Quitter', 'Fermeture de la fenêtre « Export']];
function stepIndex(stage = '') {
  if (stage.startsWith('Retour sur Accueil')) return 2;
  if (stage.startsWith('Attente du démarrage')) return 5;
  if (stage.startsWith('Retour à la liste')) return 7;
  const i = STEPS.findIndex(([, prefix]) => stage.startsWith(prefix));
  return i < 0 ? 0 : i;
}
window.overlay.on(state => {
  const pct = Math.round((state.progress || 0) * 100), now = stepIndex(state.stage);
  $('ring').setAttribute('stroke-dashoffset', String(169.6 * (1 - pct / 100)));
  $('pct').textContent = `${pct} %`;
  $('eyebrow').textContent = state.paused ? 'Pilotage en pause' : `Pilotage CapCut · projet ${state.index} sur ${state.total}`;
  $('name').textContent = state.name || 'Préparation…';
  $('stage').textContent = state.paused ? state.reason : state.stage || '';
  $('hud').classList.toggle('paused', !!state.paused);
  $('hint').replaceChildren(...(state.paused
    ? [document.createTextNode('Remets CapCut comme tu l’as trouvé, puis '), Object.assign(document.createElement('kbd'), { textContent: '⌥⌘R' }), document.createTextNode(' reprend · '), Object.assign(document.createElement('kbd'), { textContent: '⌥⌘.' }), document.createTextNode(' arrête.')]
    : [document.createTextNode('ELPO tient la souris et le clavier. Bouge la souris pour mettre en pause · '), Object.assign(document.createElement('kbd'), { textContent: '⌥⌘.' }), document.createTextNode(' arrête le lot.')]));
  $('steps').replaceChildren(...STEPS.map(([label], i) => Object.assign(document.createElement('li'), { textContent: label, className: i < now ? 'done' : i === now ? 'now' : '' })));
});
