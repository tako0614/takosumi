import { Meta, Title } from "@solidjs/meta";
import Nav from "~/components/Nav";
import Hero from "~/components/Hero";
import WhyPillars from "~/components/WhyPillars";
import HowItWorks from "~/components/HowItWorks";
import FeatureGrid from "~/components/FeatureGrid";
import Showcase from "~/components/Showcase";
import Architecture from "~/components/Architecture";
import Comparison from "~/components/Comparison";
import PureKernel from "~/components/PureKernel";
import EndCTA from "~/components/EndCTA";
import Footer from "~/components/Footer";

export default function Home() {
  return (
    <>
      <Title>Takosumi — Manifest 1 本で AWS / GCP / Cloudflare / Kubernetes へ deploy する self-hostable PaaS</Title>
      <Meta name="description" content="Self-hostable PaaS toolkit. Manifest 1 本で AWS / GCP / Cloudflare / Azure / Kubernetes / Docker / systemd へ deploy する、 Deno-native な PaaS kernel + runtime-agent + CLI。" />
      <Meta property="og:title" content="Takosumi — Self-hostable PaaS toolkit" />
      <Meta property="og:description" content="同じ manifest で AWS Fargate / Cloud Run / Kubernetes / docker-compose に deploy。 vendor lock-in を構造的に持たない PaaS。" />
      <Meta property="og:url" content="https://takosumi.com/" />
      <Meta property="og:type" content="website" />
      <Meta property="og:image" content="https://takosumi.com/brand/geometric.svg" />

      <Nav />
      <main>
        <Hero />
        <WhyPillars />
        <HowItWorks />
        <FeatureGrid />
        <Showcase />
        <Architecture />
        <Comparison />
        <PureKernel />
        <EndCTA />
      </main>
      <Footer />
    </>
  );
}
