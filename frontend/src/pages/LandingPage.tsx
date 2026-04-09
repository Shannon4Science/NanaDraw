import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

export function LandingPage() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/draw", { replace: true });
  }, [navigate]);
  return null;
}
