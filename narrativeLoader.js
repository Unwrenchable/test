// narrativeLoader.js (server-side only)
const fs = require('fs');
const path = require('path');

function safeJsonRead(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error('JSON load error:', filePath, e);
    return [];
  }
}

module.exports.loadNarrative = function (dataDir) {
  const narrative = {
    main: safeJsonRead(path.join(dataDir, 'narrative_main.json')),
    dialog: {},
    terminals: safeJsonRead(path.join(dataDir, 'terminals.json')),
    encounters: safeJsonRead(path.join(dataDir, 'encounters.json')),
    collectibles: safeJsonRead(path.join(dataDir, 'collectibles.json')),
  };

  // Load all dialog_*.json
  fs.readdirSync(dataDir)
    .filter(f => f.startsWith('dialog_') && f.endsWith('.json'))
    .forEach(f => {
      const data = safeJsonRead(path.join(dataDir, f));
      if (data?.id) narrative.dialog[data.id] = data;
    });

  return narrative;
};
