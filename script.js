const workoutWord = document.querySelector('.workout-word');

if (workoutWord) {
  const wordTrack = workoutWord.querySelector('.word-track');
  const accessibleWord = workoutWord.querySelector('.sr-only');
  const words = ['run', 'cycle', 'hike', 'walk'];
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let wordIndex = 0;
  let intervalId;

  const setWord = (index) => {
    wordIndex = index;
    wordTrack.style.transform = `translateY(calc(0.14em - ${index * 1.35}em))`;
    accessibleWord.textContent = `${words[index % words.length]}.`;
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
      setWord(wordIndex + 1);
    }, 2600);
  };

  wordTrack.addEventListener('transitionend', () => {
    if (wordIndex !== words.length) return;

    wordTrack.style.transition = 'none';
    setWord(0);
    window.requestAnimationFrame(() => {
      wordTrack.style.transition = '';
    });
  });

  motionQuery.addEventListener('change', () => {
    if (motionQuery.matches) {
      stopRotation();
    } else {
      startRotation();
    }
  });

  startRotation();
}