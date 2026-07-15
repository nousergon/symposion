-- Symposion launcher: opens the local symposion UI in the default browser.
-- Compile into a double-clickable/Dock-able app with:
--   osacompile -o ~/Applications/Symposion.app infra/Symposion.applescript
-- See infra/README.md for details.
do shell script "open http://localhost:5173"
