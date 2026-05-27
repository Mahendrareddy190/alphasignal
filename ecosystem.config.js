module.exports = {
  apps: [{
    name: 'alphasignal',
    script: 'dist/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '400M',
    env_production: {
      NODE_ENV: 'production',
      PORT: '3000',
      DB_PATH: '/data/alphasignal/futures.db',
      EMAIL_USER: 'mrmahicrypto@gmail.com',
      EMAIL_PASS: 'zfev wjdz ocxw abxz',
      JWT_SECRET: 'alphasignal_demo_secret_2024',
      OTP_EXPIRY_MINUTES: '10',
    }
  }]
};
