interface MiniUser {
  username: string;
  nickname?: string;
  role: string;
  validUntil?: string | null;
}

interface IAppOption {
  globalData: {
    token: string;
    user: MiniUser | null;
  };
  setSession(token: string, user: MiniUser | null): void;
  clearSession(): void;
}

interface ApiResponse<T> {
  code: number;
  message?: string;
  data: T;
}
