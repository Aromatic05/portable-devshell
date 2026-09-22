import { useEffect, useState } from "react";

export function useNow(intervalMs = 20_000): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const update = () => setNow(Date.now());
        const timer = window.setInterval(() => {
            if (document.visibilityState !== "hidden") update();
        }, intervalMs);
        const visibilityChanged = () => {
            if (document.visibilityState !== "hidden") update();
        };
        document.addEventListener("visibilitychange", visibilityChanged);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", visibilityChanged);
        };
    }, [intervalMs]);

    return now;
}
