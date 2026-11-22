/* v2.2부터 캐릭터 없이 텍스트만 사용한다. 기존 호출부 호환을 위해 빈 문자열을 돌려준다. */
(function (g) {
  g.frog = function () { return ''; };
})(window);
