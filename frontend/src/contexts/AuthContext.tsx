import { createContext, useContext, type ReactNode } from "react";

interface User {
  id: string;
  username: string;
  email: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  isLoggedIn: boolean;
  isLoading: boolean;
  login: () => void;
  logout: () => void;
  refresh: () => Promise<void>;
}

const localUser: User = {
  id: "local",
  username: "local",
  email: "local@localhost",
  role: "admin",
};

const AuthContext = createContext<AuthContextType>({
  user: localUser,
  isLoggedIn: true,
  isLoading: false,
  login: () => {},
  logout: () => {},
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <AuthContext.Provider
      value={{
        user: localUser,
        isLoggedIn: true,
        isLoading: false,
        login: () => {},
        logout: () => {},
        refresh: async () => {},
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}

export default AuthContext;
