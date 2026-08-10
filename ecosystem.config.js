// pm2 config. Start with: pm2 start ecosystem.config.js
//
// cwd is absolute on purpose, and node_args carries --experimental-sqlite
// because pm2 runs src/server.js directly and never goes through "npm start".
// node:sqlite is needed only to read the fleet database for logins.
module.exports = {
  apps: [{
    name: 'bc-data',
    script: 'src/server.js',
    cwd: '/var/www/becopenhagen-data',
    node_args: '--experimental-sqlite',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '400M',
  }],
};
