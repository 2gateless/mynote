const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf-8');

const styleStart = content.indexOf('<style>');
const styleEnd = content.indexOf('</style>') + 8;
const styleContent = content.substring(styleStart + 7, styleEnd - 8);

const scriptStart = content.indexOf('<script type="module">');
const scriptEnd = content.lastIndexOf('</script>') + 9;
const scriptContent = content.substring(scriptStart + 22, scriptEnd - 9);

fs.mkdirSync('src', { recursive: true });
fs.writeFileSync('src/style.css', styleContent.trim());
fs.writeFileSync('src/main.ts', scriptContent.trim());

const newHtml = content.substring(0, styleStart) + 
  '  <link rel="stylesheet" href="/src/style.css">\n' + 
  content.substring(styleEnd, scriptStart) + 
  '  <script type="module" src="/src/main.ts"></script>\n' + 
  content.substring(scriptEnd);

fs.writeFileSync('index.html', newHtml);
console.log('Split complete.');
