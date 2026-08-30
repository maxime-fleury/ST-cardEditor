// Production bundle entry — imports every app module so Bun bundles the whole
// graph into ONE artifact (js/app.js). This replaces the 13 separate
// <script type="module"> tags in public/index.html, removing:
//   - the load-order coupling (each file used to depend on window globals set
//     by the previous <script>)
//   - the need to bump ?v= busters per-file (one buster on the single bundle)
//   - the per-module entries in the service-worker shell list
//
// Import order mirrors the former <script> order in index.html for safety. The
// modules still wire together through their window.* globals (idempotent
// assignments inside a single evaluated bundle), so this is byte-for-byte the
// same app — just one file and one versioned cache key.
import "../js/tokenizer.js";
import "../js/cardEngine.js";
import "../js/animations.js";
import "../js/aiService.js";
import "../js/storage.js";
import "../js/exportUtils.js";
import "../js/editor.js";
import "../js/cardManager.js";
import "../js/aiChat.js";
import "../js/wizard.js";
import "../js/waifuTab.js";
import "../js/settings.js";
import "../js/i18n.js";
import "../js/ui.js";