const webConfig = {
    apiUrl: process.env.NEXT_PUBLIC_API_URL || 'http://165.154.254.130:3000',
    defaultAuthKey: process.env.NEXT_PUBLIC_DEFAULT_AUTH_KEY || '',
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0',
}

export default webConfig
