// Wires up `data-open-dialog="<id>"` triggers to open the matching <dialog>.
// CSP-compliant: served from same origin via `script-src 'self'`.
document.addEventListener("click", function (e) {
  var t = e.target;
  // `e.target` can be a non-Element (Text node) in rare engines — guard.
  if (!t || typeof t.closest !== "function") return;
  var trigger = t.closest("[data-open-dialog]");
  if (!trigger) return;
  var id = trigger.getAttribute("data-open-dialog");
  if (!id) return;
  var dialog = document.getElementById(id);
  // showModal() throws InvalidStateError if the dialog is already open.
  if (
    dialog &&
    typeof dialog.showModal === "function" &&
    !dialog.open
  ) {
    dialog.showModal();
  }
});
