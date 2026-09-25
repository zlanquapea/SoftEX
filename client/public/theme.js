/* Apply the saved appearance (light, dark or system) before the page paints, so it never flashes the wrong theme. */
(function () {
  try {
    var theme = localStorage.getItem('kuu-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    /* storage unavailable: follow the device setting */
  }
})();
