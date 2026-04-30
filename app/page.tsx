import { Navbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { GlassOffice } from "@/components/landing/GlassOffice";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { PrivacyFeatures } from "@/components/landing/PrivacyFeatures";
import { Logos } from "@/components/landing/Logos";
import { SocialProof } from "@/components/landing/SocialProof";
import { CTA } from "@/components/landing/CTA";
import { FAQ } from "@/components/landing/FAQ";
import { Footer } from "@/components/landing/Footer";
import { ParticleMesh } from "@/components/landing/ParticleMesh";

export default function Home() {
    return (
        <main className="min-h-screen bg-black text-white selection:bg-kast-teal/30 selection:text-black">
            <ParticleMesh />
            <div className="relative z-10">
                <Navbar />
                <Hero />
                <Logos />
                <GlassOffice />
                <HowItWorks />
                <PrivacyFeatures />
                <CTA />
                <div id="faq">
                    <FAQ />
                </div>
                <Footer />
            </div>
        </main>
    );
}
