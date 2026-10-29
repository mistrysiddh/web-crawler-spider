const ICON_LEGS = ['M6 7.2 3.8 4.2 2.2 3', 'M5.8 8.6 2.6 7.4 1 8.4', 'M5.8 9.8 2.6 11 1.4 12.8', 'M6.3 11 4 13.4 3.2 15'];
const mirror = (d) => d.replace(/(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)/g, (m, x, y) => `${Math.round((16 - Number(x)) * 10) / 10} ${y}`);

/** A small drawn spider for the status bar; takes the text colour, so it follows the theme. */
function spiderIcon() {
  const legs = [...ICON_LEGS, ...ICON_LEGS.map(mirror)];
  return jsx('svg', {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.1,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    children: [
      ...legs.map((d, i) => jsx('path', { d }, `l${i}`)),
      jsx('ellipse', { cx: 8, cy: 9.6, rx: 2.3, ry: 3, fill: 'currentColor', stroke: 'none' }, 'b'),
      jsx('circle', { cx: 8, cy: 5.6, r: 1.5, fill: 'currentColor', stroke: 'none' }, 'h'),
    ],
  });
}

function SpiderChip() {
  const [paused, setPaused] = useState(true);

  useEffect(() => {
    chipSetPaused = setPaused;
    restartSpider();
    const hintTimerId = setTimeout(() => showHint(document.querySelector('[data-wcs="chip"]')), 2500);
    return () => {
      clearTimeout(hintTimerId);
      closePanel();
      closeHint();
      if (activeApi) activeApi.destroy();
      activeApi = null;
      chipSetPaused = null;
    };
  }, []);

  return jsx('button', {
    'data-wcs': 'chip',
    onClick: (e) => togglePanel(e.currentTarget),
    title: `Web Crawler Spider settings — ${VERSION}`,
    'aria-label': 'Web Crawler Spider settings',
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: 'inherit',
      display: 'inline-flex',
      alignItems: 'center',
      opacity: paused ? 0.45 : 1,
      padding: '0 4px',
    },
    children: spiderIcon(),
  });
}

function paletteCommand(id, label, keywords, run) {
  return {
    id: `web-crawler-spider-${id}`,
    area: PALETTE_AREA,
    data: { id: `web-crawler-spider.${id}`, label: `Spider: ${label}`, keywords: ['spider', 'crawler', ...keywords], run },
  };
}

const WebCrawlerSpiderPlugin = {
  id: 'web-crawler-spider',
  name: 'Web Crawler Spider',
  defaultEnabled: true,
  register(ctx) {
    pluginStorage = ctx.storage;
    loadSettings();
    // agent mood: listen for gateway events for as long as the plugin is registered
    ctx.onEvent('*', handleGatewayEvent);
    // registerMany, not register: register() takes ONE contribution and silently mis-registers an array
    ctx.registerMany([
      {
        id: 'web-crawler-spider-chip',
        area: 'statusBar.right',
        render: () => jsx(SpiderChip, {}),
      },
      paletteCommand('toggle', 'Pause / resume', ['toggle', 'pause'], () => activeApi && activeApi.toggle()),
      paletteCommand('bigger', 'Bigger', ['size', 'larger'], () => adjust('size', 1.15)),
      paletteCommand('smaller', 'Smaller', ['size'], () => adjust('size', 1 / 1.15)),
      paletteCommand('faster', 'Faster', ['speed'], () => adjust('speed', 1.25)),
      paletteCommand('slower', 'Slower', ['speed'], () => adjust('speed', 0.8)),
      paletteCommand('body-bigger', 'Bigger body', ['body'], () => adjust('bodyScale', 1, 0.1)),
      paletteCommand('body-smaller', 'Smaller body', ['body'], () => adjust('bodyScale', 1, -0.1)),
      paletteCommand('trail', 'Silk guide line on / off', ['thread', 'web', 'trail', 'line'], () => adjust('trail', 1, CONFIG.trail ? -1 : 1)),
      paletteCommand('bugs', 'Flies on / off', ['bug', 'hunt', 'fly'], () => adjust('bugs', 1, CONFIG.bugs ? -1 : 1)),
      paletteCommand('bug-now', 'Release a fly', ['bug', 'hunt', 'fly'], () => activeApi && activeApi.spawnBug()),
      paletteCommand('helpers', 'Helper spiders on / off', ['subagent', 'helper', 'agent'], () => adjust('helpers', 1, CONFIG.helpers ? -1 : 1)),
      paletteCommand('helper-demo', 'Show a helper spider (10 s demo)', ['subagent', 'helper', 'demo'], demoHelper),
      paletteCommand('web', 'Work web on / off', ['progress', 'tool', 'web'], () => adjust('web', 1, CONFIG.web ? -1 : 1)),
      paletteCommand('web-demo', 'Show the work web (9 s demo)', ['progress', 'web', 'demo'], demoWeb),
      paletteCommand('attention', 'Attention + spider-sense on / off', ['approval', 'danger', 'attention'], () => adjust('attention', 1, CONFIG.attention ? -1 : 1)),
      paletteCommand('sense-demo', 'Test spider-sense (fake risky command)', ['danger', 'approval', 'demo'], demoSense),
      paletteCommand('wind', 'Wind on / off', ['sway', 'scroll', 'wind'], () => adjust('wind', 1, CONFIG.wind ? -1 : 1)),
      paletteCommand('peers', 'Visiting between windows on / off', ['window', 'visit', 'friend'], () => adjust('peers', 1, CONFIG.peers ? -1 : 1)),
      paletteCommand('guest-demo', 'Show a visiting spider (demo)', ['window', 'visit', 'friend', 'demo'], () => activeApi && activeApi.spawnGuest()),
      paletteCommand('visit', 'Send my spider to visit another window', ['window', 'visit', 'friend'], () => activeApi && activeApi.visitNow()),
      paletteCommand('chase', 'Cursor chase on / off', ['mouse', 'pointer', 'chase'], () => adjust('chase', 1, CONFIG.chase ? -1 : 1)),
      paletteCommand('demo-all', 'Show everything (fly, web, helper, risky command, visitor)', ['demo', 'all', 'tour', 'showcase'], demoAll),
      paletteCommand('colour', 'Next colour', ['color', 'colour', 'skin', 'theme'], () => adjust('skin', 1, CONFIG.skin >= SKINS.length - 1 ? -(SKINS.length - 1) : 1)),
      paletteCommand('explore', 'Explore the app (walk to buttons) on / off', ['explore', 'walk', 'buttons', 'dom', 'page'], () => adjust('explore', 1, CONFIG.explore ? -1 : 1)),
      paletteCommand('background', 'Freeze in the background on / off', ['background', 'idle', 'cpu', 'battery', 'focus'], () => adjust('background', 1, CONFIG.background ? -1 : 1)),
      paletteCommand('chase-now', 'Chase my cursor now', ['mouse', 'pointer', 'chase'], () => activeApi && activeApi.chase()),
      paletteCommand('nap', 'Take a nap', ['sleep', 'rest'], () => activeApi && activeApi.nap()),
      paletteCommand('wake', 'Wake up', ['sleep'], () => activeApi && activeApi.wake()),
      paletteCommand('reset', 'Reset size, speed and extras', ['default', 'settings'], resetSettings),
    ]);
  },
};

export default WebCrawlerSpiderPlugin;
