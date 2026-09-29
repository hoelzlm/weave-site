const workoutWord = document.querySelector('.workout-word');

if (workoutWord) {
  const wordTrack = workoutWord.querySelector('.word-track');
  const accessibleWord = workoutWord.querySelector('.sr-only');
  const items = Array.from(wordTrack.children);
  const wordCount = items.length - 1; // the last item repeats the first for a seamless loop
  const fitsToWord = workoutWord.hasAttribute('data-fit');
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let wordIndex = 0;
  let intervalId;

  const fitWidth = (index) => {
    if (!fitsToWord) return;
    const range = document.createRange();
    range.selectNodeContents(items[index % wordCount]);
    workoutWord.style.width = `${Math.ceil(range.getBoundingClientRect().width)}px`;
  };

  const setWord = (index) => {
    wordIndex = index;
    wordTrack.style.transform = `translateY(calc(0.14em - ${index * 1.35}em))`;
    accessibleWord.textContent = items[index % wordCount].textContent;
    fitWidth(index);
  };

  const stopRotation = () => {
    window.clearInterval(intervalId);
    intervalId = undefined;
    wordTrack.style.transition = 'none';
    setWord(0);
  };

  const startRotation = () => {
    if (motionQuery.matches || intervalId) return;

    wordTrack.style.transition = '';
    intervalId = window.setInterval(() => {
      if (wordIndex >= wordCount) {
        // The last item repeats the first, so jump back to it without animating, then advance.
        wordTrack.style.transition = 'none';
        setWord(0);
        void wordTrack.offsetHeight;
        wordTrack.style.transition = '';
      }
      setWord(wordIndex + 1);
    }, 2600);
  };

  motionQuery.addEventListener('change', () => {
    if (motionQuery.matches) {
      stopRotation();
    } else {
      startRotation();
    }
  });

  window.addEventListener('resize', () => fitWidth(wordIndex));
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => fitWidth(wordIndex));
  }

  fitWidth(0);
  startRotation();
}

document.querySelectorAll('[data-set-lang]').forEach((link) => {
  link.addEventListener('click', () => {
    try {
      localStorage.setItem('weave-lang', link.dataset.setLang);
    } catch (e) {
      // storage blocked: the ?lang=en query on the English link still prevents a redirect loop
    }
  });
});
