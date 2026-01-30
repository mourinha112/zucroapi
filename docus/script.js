// Initialize syntax highlighting
document.addEventListener('DOMContentLoaded', () => {
  hljs.highlightAll();
  initNavigation();
  initTheme();
  initAccordions();
  initCodeTabs();
  initCopyButtons();
  initMobileMenu();
});

// Navigation
function initNavigation() {
  const navLinks = document.querySelectorAll('.nav-link');
  const sections = document.querySelectorAll('.content-section');
  const cards = document.querySelectorAll('[data-navigate]');

  function showSection(sectionId) {
    // Hide all sections
    sections.forEach(section => section.classList.remove('active'));
    
    // Show target section
    const targetSection = document.getElementById(sectionId);
    if (targetSection) {
      targetSection.classList.add('active');
    }

    // Update nav links
    navLinks.forEach(link => {
      link.classList.remove('active');
      if (link.dataset.section === sectionId) {
        link.classList.add('active');
      }
    });

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Close mobile menu
    document.getElementById('sidebar').classList.remove('open');

    // Update URL hash
    history.pushState(null, null, `#${sectionId}`);
  }

  // Nav link clicks
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const sectionId = link.dataset.section;
      showSection(sectionId);
    });
  });

  // Card navigation
  cards.forEach(card => {
    card.addEventListener('click', (e) => {
      e.preventDefault();
      const sectionId = card.dataset.navigate;
      showSection(sectionId);
    });
  });

  // Inline links with data-navigate
  document.querySelectorAll('a[data-navigate]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const sectionId = link.dataset.navigate;
      showSection(sectionId);
    });
  });

  // Handle hash on load
  if (window.location.hash) {
    const sectionId = window.location.hash.slice(1);
    showSection(sectionId);
  }

  // Handle hash change
  window.addEventListener('hashchange', () => {
    const sectionId = window.location.hash.slice(1);
    if (sectionId) {
      showSection(sectionId);
    }
  });
}

// Theme Toggle
function initTheme() {
  const themeToggle = document.getElementById('themeToggle');
  const savedTheme = localStorage.getItem('theme');

  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  themeToggle.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
  });
}

// Accordions
function initAccordions() {
  const accordionHeaders = document.querySelectorAll('.accordion-header');

  accordionHeaders.forEach(header => {
    header.addEventListener('click', () => {
      const item = header.parentElement;
      item.classList.toggle('open');
    });
  });
}

// Code Tabs
function initCodeTabs() {
  const codeTabs = document.querySelectorAll('.code-tabs');

  codeTabs.forEach(container => {
    const buttons = container.querySelectorAll('.code-tab-btn');
    const contents = container.querySelectorAll('.code-tab-content');

    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;

        // Update buttons
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Update contents
        contents.forEach(content => {
          content.classList.remove('active');
          if (content.dataset.tab === tab) {
            content.classList.add('active');
          }
        });
      });
    });
  });
}

// Copy Buttons
function initCopyButtons() {
  const copyButtons = document.querySelectorAll('.copy-btn');

  copyButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const codeBlock = btn.closest('.code-block');
      const code = codeBlock.querySelector('code');
      const text = btn.dataset.copy || code.textContent;

      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copiado!';
        btn.classList.add('copied');

        setTimeout(() => {
          btn.textContent = 'Copiar';
          btn.classList.remove('copied');
        }, 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    });
  });
}

// Mobile Menu
function initMobileMenu() {
  const menuToggle = document.getElementById('menuToggle');
  const sidebar = document.getElementById('sidebar');

  menuToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!sidebar.contains(e.target) && !menuToggle.contains(e.target)) {
      sidebar.classList.remove('open');
    }
  });
}

// Search functionality (optional enhancement)
function initSearch() {
  const searchInput = document.getElementById('search');
  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const navLinks = document.querySelectorAll('.nav-link');

    navLinks.forEach(link => {
      const text = link.textContent.toLowerCase();
      const parent = link.closest('.nav-section');
      
      if (text.includes(query) || query === '') {
        link.style.display = '';
        if (parent) parent.style.display = '';
      } else {
        link.style.display = 'none';
      }
    });
  });
}
