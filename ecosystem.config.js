module.exports = {
  apps: [{
    name: 'zucropay-api',
    script: 'dist/app.js',
    cwd: '/var/www/zucropay-api',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: '/var/www/zucropay-api/logs/error.log',
    out_file: '/var/www/zucropay-api/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
