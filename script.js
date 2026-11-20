document.querySelectorAll('[data-set-lang]').forEach((link) => {
  link.addEventListener('click', () => {
    try {
      localStorage.setItem('weave-lang', link.dataset.setLang);
    } catch (e) {
      // storage blocked: the ?lang=en query on the English link still prevents a redirect loop
    }
  });
});

// Draw each route line once when it scrolls into view (the hero line draws on load via CSS).
const drawn = document.querySelectorAll('.band-route');
if (drawn.length && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('is-drawn'); io.unobserve(e.target); }
    });
  }, { threshold: 0.6 });
  drawn.forEach((el) => io.observe(el));
} else {
  drawn.forEach((el) => el.classList.add('is-drawn'));
}
