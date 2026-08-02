// EmailAccount is now defined in src/config.ts as z.infer<typeof emailAccountSchema>
// Re-exported here for backward compatibility with all existing import sites.
export type { EmailAccount } from '../config.js';

export type AuthType = 'login' | 'oauth2';

export interface Credentials {
  password?: string;
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: number;
}
