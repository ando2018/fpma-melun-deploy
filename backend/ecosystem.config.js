// Config PM2 : sur le serveur, lancer avec `pm2 start ecosystem.config.js`.
module.exports = {
  apps: [
    {
      name: 'fpma-backend',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
