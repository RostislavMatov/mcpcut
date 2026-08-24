import { buildAsset, type Asset } from './asset.js'

/**
 * The servers-page enhancement (`/assets/servers.js`): inside the server
 * form's modal, the `args` textarea (one argument per line — the no-JS
 * contract the handler parses) is replaced with the design's ROW editor: a
 * numbered input per argument, a per-row remove button and "+ Add argument"
 * (Servers.dc.html). The textarea stays in the form, hidden, as the single
 * source of truth: every row change is synced back into it, so the POST the
 * server sees is byte-identical to what a no-JS submission would send.
 *
 * Values only ever travel through `input.value`/`textContent` — the script
 * builds nodes with createElement and never assembles HTML, so a hostile
 * argument string has no path into markup.
 */
const SERVERS_JS_SOURCE = `(function () {
  "use strict";

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function boot() {
    var field = document.querySelector(".srv-form .args-field");
    var ta = field ? field.querySelector("textarea[name='args']") : null;
    if (!field || !ta) return;

    var rows = document.createElement("div");
    rows.className = "arg-rows";
    var head = document.createElement("div");
    head.className = "between";
    var label = document.createElement("span");
    label.className = "label";
    label.textContent = "args";
    var count = document.createElement("span");
    count.className = "faint small num";
    head.appendChild(label);
    head.appendChild(count);

    function sync() {
      var inputs = rows.querySelectorAll("input");
      var values = [];
      var n = 0;
      for (var i = 0; i < inputs.length; i++) {
        values.push(inputs[i].value);
        if (inputs[i].value.trim() !== "") n++;
        var num = inputs[i].parentNode.firstChild;
        num.textContent = pad(i);
      }
      ta.value = values.join("\\n");
      count.textContent = n + " / 100";
    }

    function addRow(value) {
      var row = document.createElement("div");
      row.className = "arg-row";
      var num = document.createElement("span");
      num.className = "arg-i num";
      var input = document.createElement("input");
      input.type = "text";
      input.value = value;
      input.placeholder = rows.children.length === 0 ? "mcp-server-postgres" : "--readonly";
      input.addEventListener("input", sync);
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "arg-x";
      remove.title = "Remove argument";
      remove.textContent = "\\u00d7";
      remove.addEventListener("click", function () { row.remove(); sync(); });
      row.appendChild(num);
      row.appendChild(input);
      row.appendChild(remove);
      rows.appendChild(row);
      return input;
    }

    var add = document.createElement("button");
    add.type = "button";
    add.className = "arg-add";
    add.textContent = "+ Add argument";
    add.addEventListener("click", function () { addRow("").focus(); sync(); });

    var initial = ta.value === "" ? [] : ta.value.split("\\n");
    if (initial.length === 0) initial = [""];
    for (var i = 0; i < initial.length; i++) addRow(initial[i]);

    field.classList.add("is-rows");
    field.insertBefore(add, field.querySelector(".field-hint"));
    field.insertBefore(rows, add);
    field.insertBefore(head, rows);
    var form = ta.closest("form");
    if (form) form.addEventListener("submit", sync);
    sync();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
`

/** The servers script asset, digested once at module load. */
export const SERVERS_JS: Asset = buildAsset(SERVERS_JS_SOURCE, 'text/javascript; charset=utf-8')
