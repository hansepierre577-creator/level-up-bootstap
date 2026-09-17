document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('searchForm');
  const input = document.getElementById('searchInput');
  const result = document.getElementById('searchResult');
  const clearBtn = document.getElementById('searchClear');
  const nextBtn = document.getElementById('searchNext');
  const prevBtn = document.getElementById('searchPrev');
  const matchCase = document.getElementById('matchCase');
  const wholeWord = document.getElementById('wholeWord');
  const controls = document.getElementById('searchControls');
  const searchAreas = document.querySelectorAll('main, footer');

  let matches = [];
  let current = -1;
  let lastQuery = '';
  let debounceTimer = null;
  const suggestionBox = document.getElementById('suggestionBox');
  let wordSuggestions = new Set(); // Changed to let

  // Translations for search.js specific texts
  const searchTranslations = {
    fr: {
      resultat: "résultat",
      resultats: "résultats",
      aucunResultat: "Aucun résultat",
      effacer: "Effacer"
    },
    en: {
      resultat: "result",
      resultats: "results",
      aucunResultat: "No result",
      effacer: "Clear"
    },
    ht: {
      resultat: "rezilta",
      resultats: "rezilta",
      aucunResultat: "Pa gen rezilta",
      effacer: "Efase"
    },
    es: {
      resultat: "resultado",
      resultats: "resultados",
      aucunResultat: "Ningún resultado",
      effacer: "Borrar"
    },
    pt: {
      resultat: "resultado",
      resultats: "resultados",
      aucunResultat: "Nenhum resultado",
      effacer: "Limpar"
    },
    de: {
      resultat: "Ergebnis",
      resultats: "Ergebnisse",
      aucunResultat: "Kein Ergebnis",
      effacer: "Löschen"
    }
  };


  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'); }

  function buildSuggestions() {
    const wordRegex = /\b[\p{L}0-9][\p{L}0-9'’-]*\b/gu;
    searchAreas.forEach(area => {
      walkTextNodes(area, node => {
        const words = node.nodeValue.match(wordRegex);
        if (!words) return;
        words.forEach(word => wordSuggestions.add(word));
      });
    });
  }

  function renderSuggestions(prefix) {
    if (!prefix) {
      suggestionBox.classList.add('d-none');
      suggestionBox.innerHTML = '';
      return;
    }

    const normalized = matchCase.checked ? prefix : prefix.toLowerCase();
    const suggestions = Array.from(wordSuggestions)
      .filter(word => {
        const test = matchCase.checked ? word : word.toLowerCase();
        return test.startsWith(normalized) && word.length > prefix.length;
      })
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: matchCase.checked ? 'case' : 'base' }))
      .slice(0, 6);

    if (!suggestions.length) {
      suggestionBox.classList.add('d-none');
      suggestionBox.innerHTML = '';
      return;
    }

    suggestionBox.innerHTML = suggestions.map(word => {
      const suffix = word.slice(prefix.length);
      return `<button type="button" class="search-suggestion-item" data-value="${word}"><span class="search-suggestion-full">${prefix}</span><span class="search-suggestion-partial">${suffix}</span></button>`;
    }).join('');
    suggestionBox.classList.remove('d-none');
  }

  function attachSuggestionEvents() {
    suggestionBox.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (!button) return;
      const value = button.dataset.value;
      input.value = value;
      suggestionBox.classList.add('d-none');
      doSearch(value);
    });
  }

  function clearHighlights() {
    matches = [];
    current = -1;
    document.querySelectorAll('mark.search-highlight').forEach(mark => {
      mark.replaceWith(document.createTextNode(mark.textContent));
    });
  }

  function walkTextNodes(root, callback) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentNode;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        if (parent.closest && parent.closest('mark.search-highlight')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      callback(node);
    }
  }

  function highlightTextNode(textNode, regex) {
    const text = textNode.nodeValue;
    let match;
    let lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let count = 0;

    while ((match = regex.exec(text)) !== null) {
      const before = text.slice(lastIndex, match.index);
      if (before) fragment.appendChild(document.createTextNode(before));
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = match[0];
      fragment.appendChild(mark);
      lastIndex = match.index + match[0].length;
      count += 1;
      if (match[0].length === 0) {
        regex.lastIndex += 1;
      }
    }

    if (count === 0) return 0;

    const after = text.slice(lastIndex);
    if (after) fragment.appendChild(document.createTextNode(after));
    textNode.replaceWith(fragment);
    return count;
  }

  function findMatches(query) {
    clearHighlights();
    if (!query) return 0;
    const flags = matchCase.checked ? 'g' : 'gi';
    const wordBoundary = wholeWord.checked ? '\\b' : '';
    const regex = new RegExp(wordBoundary + escapeRegExp(query) + wordBoundary, flags);
    let count = 0;

    searchAreas.forEach(area => {
      walkTextNodes(area, node => {
        count += highlightTextNode(node, regex);
      });
    });

    matches = Array.from(document.querySelectorAll('mark.search-highlight'));
    matches.forEach((m, i) => m.setAttribute('data-search-index', i));
    return count;
  }

  function updateUI(count) {
    const lang = localStorage.getItem('levelup_language') || 'fr';
    const t = searchTranslations[lang] || searchTranslations.fr;

    if (count > 0) {
      result.textContent = (current >= 0 ? (current + 1) + '/' : '') + count + (count > 1 ? ` ${t.resultats}` : ` ${t.resultat}`);
      result.classList.remove('d-none');
      clearBtn.classList.remove('d-none');
      nextBtn.classList.remove('d-none');
      prevBtn.classList.remove('d-none');
      if (controls) controls.classList.remove('d-none');
    } else {
      result.textContent = t.aucunResultat;
      result.classList.remove('d-none');
      clearBtn.classList.remove('d-none');
      nextBtn.classList.add('d-none');
      prevBtn.classList.add('d-none');
      controls.classList.remove('d-none');
    }
  }

  function setActive(index) {
    if (matches.length === 0) return;
    matches.forEach(m => m.classList.remove('active'));
    current = ((index % matches.length) + matches.length) % matches.length;
    const el = matches[current];
    el.classList.add('active');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    updateUI(matches.length);
  }

  function doSearch(rawQuery) {
    const q = rawQuery.trim();
    if (!q) {
      clearHighlights();
      result.classList.add('d-none');
      clearBtn.classList.add('d-none');
      if (controls) controls.classList.add('d-none');
      return;
    }
    const count = findMatches(q);
    lastQuery = q;
    if (count > 0) {
      current = 0;
      setActive(0);
    } else {
      updateUI(0);
      current = -1;
    }
  }

  function debounceSearch(value) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => doSearch(value), 300);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    suggestionBox.classList.add('d-none');
    doSearch(input.value);
  });

  input.addEventListener('input', (e) => {
    const value = e.target.value;
    renderSuggestions(value);
    debounceSearch(value);
  });

  buildSuggestions();
  attachSuggestionEvents();

  nextBtn.addEventListener('click', () => {
    if (matches.length === 0) return;
    setActive(current + 1);
  });

  prevBtn.addEventListener('click', () => {
    if (matches.length === 0) return;
    setActive(current - 1);
  });

  clearBtn.addEventListener('click', () => {
    clearHighlights();
    result.classList.add('d-none');
    clearBtn.classList.add('d-none');
    nextBtn.classList.add('d-none');
    prevBtn.classList.add('d-none');
    input.value = '';
    suggestionBox.classList.add('d-none');
    if (controls) controls.classList.add('d-none');
  });

  // keyboard shortcuts: Ctrl/Cmd+F to focus
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  // update search on option changes
  [matchCase, wholeWord].forEach(opt => {
    if (!opt) return;
    opt.addEventListener('change', () => {
      if (lastQuery) doSearch(lastQuery);
    });
  });

});
