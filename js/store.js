/* 브라우저 저장소 — localStorage 를 쓰되, 막혀 있거나 가득 차면 메모리로만 동작합니다 */
(function (root) {
  'use strict';
  var KEY = 'data09-04.state';
  var memory = {};
  var ok = true;
  function get(k) {
    try { var v = root.localStorage.getItem(k); return v == null && memory[k] != null ? memory[k] : v; }
    catch (e) { ok = false; return memory[k] == null ? null : memory[k]; }
  }
  function set(k, v) {
    memory[k] = v;
    try { root.localStorage.setItem(k, v); return true; } catch (e) { ok = false; return false; }
  }
  function del(k) {
    delete memory[k];
    try { root.localStorage.removeItem(k); } catch (e) { ok = false; }
  }
  root.FRFStore = {
    load: function () { try { return JSON.parse(get(KEY) || 'null'); } catch (e) { return null; } },
    // 반환값 false = 브라우저 저장소에 못 씀(용량 초과 등). 이 창을 닫기 전까지는 메모리에 남습니다.
    save: function (state) { return set(KEY, JSON.stringify(state)); },
    clear: function () { del(KEY); },
    available: function () { get(KEY); return ok; }
  };
})(window);
