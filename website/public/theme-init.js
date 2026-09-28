(function () {
  var root = document.documentElement;
  root.classList.add("js");

  var media = window.matchMedia("(prefers-color-scheme: dark)");
  var color = document.querySelector('meta[name="theme-color"]');
  function applyTheme() {
    var theme = media.matches ? "dark" : "light";
    root.dataset.theme = theme;
    if (color) color.setAttribute("content", theme === "dark" ? "#0a0a0b" : "#f7f7f8");
  }

  applyTheme();
  if (media.addEventListener) media.addEventListener("change", applyTheme);
  else media.addListener(applyTheme);
})();
