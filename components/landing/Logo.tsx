"use client";

import Image from "next/image";

export function Logo({ className = "w-10 h-10" }: { className?: string }) {
    return (
        <div className={`relative flex items-center justify-center ${className} group`}>
            <Image
                src="/logo.png"
                alt="Expaynse Logo"
                fill
                className="object-contain invert mix-blend-screen group-hover:scale-110 transition-transform duration-500"
                priority
            />
        </div>
    );
}
