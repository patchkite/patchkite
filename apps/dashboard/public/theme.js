// Patchkite Design System theme: light/dark follows the system.
(function () {
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  var apply = function () { document.documentElement.dataset.theme = mq.matches ? "dark" : "light"; };
  apply();
  mq.addEventListener("change", apply);
})();
