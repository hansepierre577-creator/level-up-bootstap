(() => {
    const darkModeKey = 'levelup_darkMode';
    const body = document.body;
    const toggle = document.getElementById('darkModeToggle');

    function applyTheme() {
        const isDark = localStorage.getItem(darkModeKey) === 'enabled';
        body.classList.toggle('dark-mode', isDark);
        if (toggle) {
            toggle.innerHTML = `<i class="bi ${isDark ? 'bi-sun-fill' : 'bi-moon-fill'}"></i>`;
            toggle.setAttribute('aria-label', isDark ? 'Activer le mode clair' : 'Activer le mode sombre');
            toggle.setAttribute('title', isDark ? 'Mode clair' : 'Mode sombre');
        }
    }

    applyTheme();

    if (toggle) {
        toggle.addEventListener('click', () => {
            const isDark = !body.classList.contains('dark-mode');
            localStorage.setItem(darkModeKey, isDark ? 'enabled' : 'disabled');
            applyTheme();
        });
    }

    window.addEventListener('storage', (event) => {
        if (event.key === darkModeKey) applyTheme();
    });
})();
