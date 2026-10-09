// Aiming sight: a transparent full-screen window above CapCut. One click records the point
// (the main process reads the real cursor position), Escape cancels.
const $ = id => document.getElementById(id);
const TEXT = {
  tile: ['Vise la première vignette de projet', 'Sur l’accueil de CapCut (trié par date de modification), clique au centre de la première vignette.'],
  exportButton: ['Vise le bouton « Exporter »', 'Dans la fenêtre d’export de CapCut (⌘E), clique au centre du bouton « Exporter ».'],
};
window.overlay.on(state => {
  const [title, text] = TEXT[state.target] || TEXT.tile;
  $('title').textContent = title;
  $('text').replaceChildren(document.createTextNode(`${text} `), Object.assign(document.createElement('kbd'), { textContent: 'Échap' }), document.createTextNode(' annule.'));
});
document.addEventListener('mousemove', e => {
  for (const id of ['lineH', 'lineV', 'target', 'coords']) $(id).hidden = false;
  $('lineH').style.top = `${e.clientY}px`; $('lineV').style.left = `${e.clientX}px`;
  $('target').style.left = `${e.clientX}px`; $('target').style.top = `${e.clientY}px`;
  $('coords').style.left = `${e.clientX + 22}px`; $('coords').style.top = `${e.clientY + 22}px`;
  $('coords').textContent = `x ${Math.round(e.screenX)} · y ${Math.round(e.screenY)}`;
});
document.addEventListener('mousedown', e => { if (e.button === 0) { e.preventDefault(); window.overlay.aimed(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape') window.overlay.cancel(); });
