// Wires up `data-open-dialog="<id>"` triggers to open the matching <dialog>.
// CSP-compliant: served from same origin via `script-src 'self'`.
document.addEventListener("click", function (e) {
  var trigger = e.target.closest("[data-open-dialog]");
  if (!trigger) return;
  var id = trigger.getAttribute("data-open-dialog");
  if (!id) return;
  var dialog = document.getElementById(id);
  if (dialog && typeof dialog.showModal === "function") {
    dialog.showModal();
  }
});
