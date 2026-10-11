// Pilot HUD: a small window above CapCut, click-through, fed by the main process.
const $ = id => document.getElementById(id);
const STEPS = [['Fermer', 'Fermeture de CapCut'], ['En tête', 'Projet placé en tête'], ['Lancer', 'Lancement de CapCut'], ['Ouvrir', 'Ouverture du projet'],
  ['Réglages', 'Ouverture des réglages'], ['Exporter', 'Lancement de l’export'], ['Export', 'Export'], ['Fichier', 'CapCut a terminé'], ['Quitter', 'Fermeture du panneau']];
function stepIndex(stage = '', progress = 0) {
  // CapCut is closed at the start and at the end of each project.
  if (stage.startsWith('Fermeture de CapCut') && progress > 0.5) return STEPS.length - 1;
  const i = STEPS.findIndex(([, prefix]) => stage.startsWith(prefix));
  return i < 0 ? 0 : i;
}
window.overlay.on(state => {
  const pct = Math.round((state.progress || 0) * 100), now = stepIndex(state.stage, state.progress);
  $('ring').setAttribute('stroke-dashoffset', String(169.6 * (1 - pct / 100)));
  $('pct').textContent = `${pct} %`;
  $('eyebrow').textContent = state.paused ? 'Pilotage en pause' : `Pilotage CapCut · projet ${state.index} sur ${state.total}`;
  $('name').textContent = state.name || 'Préparation…';
  $('stage').textContent = state.paused ? state.reason : state.stage || '';
  $('hud').classList.toggle('paused', !!state.paused);
  $('hint').replaceChildren(...(state.paused
    ? [document.createTextNode('Remets CapCut comme tu l’as trouvé, puis '), Object.assign(document.createElement('kbd'), { textContent: '⌥⌘R' }), document.createTextNode(' reprend · '), Object.assign(document.createElement('kbd'), { textContent: '⌥⌘.' }), document.createTextNode(' arrête.')]
    : [document.createTextNode('ELPO pilote CapCut. Bouge la souris pour mettre en pause · '), Object.assign(document.createElement('kbd'), { textContent: '⌥⌘.' }), document.createTextNode(' arrête le lot.')]));
  $('steps').replaceChildren(...STEPS.map(([label], i) => Object.assign(document.createElement('li'), { textContent: label, className: i < now ? 'done' : i === now ? 'now' : '' })));
});
