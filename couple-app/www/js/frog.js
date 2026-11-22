/* 개굴씨 캐릭터 (오리지널 SVG). mood: happy | calm | worry | cheer | love */
(function (g) {
  function frog(mood = 'happy', size = 96) {
    const mouths = {
      happy: '<path d="M38 66 Q50 76 62 66" fill="none" stroke="#1D3B2A" stroke-width="3" stroke-linecap="round"/>',
      calm: '<path d="M42 68 Q50 72 58 68" fill="none" stroke="#1D3B2A" stroke-width="3" stroke-linecap="round"/>',
      worry: '<path d="M41 71 Q50 65 59 71" fill="none" stroke="#1D3B2A" stroke-width="3" stroke-linecap="round"/>',
      cheer: '<path d="M37 64 Q50 82 63 64 Z" fill="#B23A48" stroke="#1D3B2A" stroke-width="2.5" stroke-linejoin="round"/><path d="M44 71 Q50 76 56 71" fill="#F28B9B"/>',
      love: '<path d="M38 66 Q50 76 62 66" fill="none" stroke="#1D3B2A" stroke-width="3" stroke-linecap="round"/>'
    };
    const eye = (cx) => {
      if (mood === 'calm') return `<path d="M${cx - 6} 33 Q${cx} 38 ${cx + 6} 33" fill="none" stroke="#1D3B2A" stroke-width="3" stroke-linecap="round"/>`;
      if (mood === 'love') return `<path d="M${cx} 39 l-6 -6 a3.6 3.6 0 0 1 6 -4 a3.6 3.6 0 0 1 6 4 z" fill="#E0475B"/>`;
      return `<circle cx="${cx}" cy="33" r="5.5" fill="#1D3B2A"/><circle cx="${cx + 2}" cy="31" r="1.8" fill="#fff"/>`;
    };
    const brow = mood === 'worry'
      ? '<path d="M26 22 L36 25 M74 22 L64 25" stroke="#1D3B2A" stroke-width="2.5" stroke-linecap="round"/>' : '';
    return `<svg class="frog" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" aria-label="개굴씨">
      <ellipse cx="50" cy="93" rx="30" ry="4" fill="rgba(0,0,0,.12)"/>
      <path d="M20 86 Q14 90 22 92 L36 92 Q38 86 32 84 Z" fill="#4E9E5F"/>
      <path d="M80 86 Q86 90 78 92 L64 92 Q62 86 68 84 Z" fill="#4E9E5F"/>
      <ellipse cx="50" cy="62" rx="36" ry="28" fill="#6CC07A"/>
      <ellipse cx="50" cy="70" rx="22" ry="16" fill="#D8F0C8"/>
      <circle cx="31" cy="34" r="15" fill="#6CC07A"/>
      <circle cx="69" cy="34" r="15" fill="#6CC07A"/>
      <circle cx="31" cy="34" r="10" fill="#fff"/>
      <circle cx="69" cy="34" r="10" fill="#fff"/>
      ${eye(31)}${eye(69)}${brow}
      <ellipse cx="25" cy="58" rx="6" ry="3.5" fill="#F4A3A8" opacity=".85"/>
      <ellipse cx="75" cy="58" rx="6" ry="3.5" fill="#F4A3A8" opacity=".85"/>
      ${mouths[mood] || mouths.happy}
      <path d="M44 18 Q50 8 56 18" fill="#F6C945" stroke="#C99A1E" stroke-width="1.5"/>
    </svg>`;
  }
  g.frog = frog;
})(window);
