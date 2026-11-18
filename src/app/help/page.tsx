import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { AccessApplication } from "@/components/access-application";
import { HelpDownloads } from "@/components/help-downloads";
import { HelpShowcase } from "@/components/help-showcase";
import { IosInstall } from "@/components/ios-install";
import { LanguageToggle } from "@/components/language-toggle";
import { withAppBasePath } from "@/lib/base-path";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { getIosInstallOffer } from "@/lib/ios-install";
import { isOpsAdminInstance } from "@/lib/ops/config";

export async function generateMetadata(): Promise<Metadata> {
  const labels = getMessages(await getServerLocale()).help;
  return { title: `${labels.title} · BillBoard`, description: labels.description };
}

export default async function HelpPage() {
  if (isOpsAdminInstance()) redirect("/ops");
  const [locale, iosOffer] = await Promise.all([getServerLocale(), getIosInstallOffer()]);
  const messages = getMessages(locale);
  const labels = messages.help;

  return (
    <main className="mx-auto max-w-6xl px-4 pb-12 pt-[calc(1.5rem+env(safe-area-inset-top))] sm:px-6 lg:px-8">
      <header className="mb-8 space-y-5 border-b border-[var(--bb-warm-line)] pb-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-base font-medium tracking-tight text-[var(--bb-primary)]">{messages.app.brand}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Link className="inline-flex min-h-11 items-center gap-1 text-sm font-medium hover:text-[var(--bb-primary)]" href="/home" prefetch={false}>
              {labels.enter}<ArrowUpRight aria-hidden="true" className="h-4 w-4 shrink-0" />
            </Link>
            <LanguageToggle labels={messages.language} locale={locale} />
          </div>
        </div>
        <div className="max-w-2xl space-y-3">
          <h1 className="text-2xl font-medium tracking-tight">{labels.title}</h1>
          <p className="text-sm leading-7 text-[var(--bb-muted)] sm:text-base">{labels.description}</p>
        </div>
        <nav aria-label={labels.showcase.navigation} className="flex flex-wrap gap-x-6 gap-y-1">
          {[["features", labels.showcase.features], ["downloads", labels.showcase.downloads], ["apply", labels.showcase.apply], ["contents", labels.showcase.guide]].map(([id, title]) =>
            <a className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--bb-primary)] underline-offset-4 hover:underline" href={`#${id}`} key={id}>{title}</a>)}
        </nav>
      </header>

      <HelpShowcase locale={locale} />

      <HelpDownloads downloadUrls={{ android: withAppBasePath("/api/downloads/android"), windows: withAppBasePath("/api/downloads/windows") }}
        labels={labels.downloads} locale={locale} metadataUrl={withAppBasePath("/api/downloads")} />
      <IosInstall grantUrl={withAppBasePath("/api/ios/install")} labels={labels.iosInstall} offer={iosOffer} />

      <AccessApplication locale={locale} />

      <nav aria-label={labels.contents} className="my-10 scroll-mt-6 ios-panel p-5 sm:p-6" id="contents">
        <h2 className="mb-3 text-base font-medium">{labels.contents}</h2>
        <ol className="grid gap-x-8 sm:grid-cols-2">
          {labels.chapters.map((chapter, index) => <li className="min-w-0" key={chapter.id}>
            <a className="flex min-h-11 items-center gap-3 py-2 text-sm hover:text-[var(--bb-primary)]" href={`#${chapter.id}`}>
              <span aria-hidden="true" className="w-5 shrink-0 text-xs tabular-nums text-[var(--bb-muted)]">{String(index + 1).padStart(2, "0")}</span>
              <span>{chapter.title}</span>
            </a>
          </li>)}
          <li><a className="flex min-h-11 items-center gap-3 py-2 text-sm hover:text-[var(--bb-primary)]" href="#faq">
            <span aria-hidden="true" className="w-5 shrink-0 text-xs tabular-nums text-[var(--bb-muted)]">10</span>{labels.faqTitle}
          </a></li>
        </ol>
        <p className="mt-4 border-t border-[var(--bb-warm-line)] pt-4 text-xs leading-6 text-[var(--bb-muted)]">{labels.demoCaption} {labels.imageHint}</p>
      </nav>

      <div className="space-y-12 sm:space-y-16">
        {labels.chapters.map((chapter, index) => {
          const imagePath = withAppBasePath(`/images/help/${chapter.image}-${locale}.png`);
          return <section aria-labelledby={`${chapter.id}-title`} className="scroll-mt-6 border-t border-[var(--bb-warm-line)] pt-7" id={chapter.id} key={chapter.id}>
            <header className="mb-6 space-y-3">
              <div className="flex items-baseline gap-3">
                <span aria-hidden="true" className="text-sm font-medium tabular-nums text-[var(--bb-primary)]">{String(index + 1).padStart(2, "0")}</span>
                <h2 className="text-lg font-medium tracking-tight sm:text-xl" id={`${chapter.id}-title`}>{chapter.title}</h2>
              </div>
              <p className="max-w-2xl text-sm leading-7 text-[var(--bb-muted)]">{chapter.summary}</p>
            </header>
            <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,390px)] lg:gap-10">
              <div className="min-w-0 space-y-7">
                {chapter.topics.map((topic) => <div className="space-y-3" key={topic.title}>
                  <h3 className="text-base font-medium">{topic.title}</h3>
                  <ol className="list-decimal space-y-3 pl-5 text-sm leading-7 marker:text-[var(--bb-muted)]">
                    {topic.steps.map((step) => <li className="pl-1" key={step}>{step}</li>)}
                  </ol>
                  <p className="border-l-2 border-[var(--bb-line-strong)] pl-4 text-sm leading-7 text-[var(--bb-muted)]">
                    <span className="font-medium text-[var(--bb-ink)]">{labels.note} · </span>{topic.note}
                  </p>
                </div>)}
              </div>
              <figure className="mx-auto w-full max-w-[390px]">
                <a className="block overflow-hidden rounded-2xl border border-[var(--bb-line-strong)] bg-white" href={imagePath}>
                  <Image alt={chapter.imageAlt} className="h-auto w-full" height={844} loading="lazy" src={imagePath} unoptimized width={390} />
                </a>
                <figcaption className="mt-3 text-xs leading-5 text-[var(--bb-muted)]">{chapter.imageAlt}</figcaption>
              </figure>
            </div>
            <a className="mt-5 inline-flex min-h-11 items-center text-sm font-medium text-[var(--bb-primary)] underline underline-offset-4" href="#contents">{labels.backToContents}</a>
          </section>;
        })}
        <section aria-labelledby="faq-title" className="scroll-mt-6 border-t border-[var(--bb-warm-line)] pt-7" id="faq">
          <h2 className="mb-5 text-lg font-medium tracking-tight sm:text-xl" id="faq-title">{labels.faqTitle}</h2>
          <dl className="max-w-3xl space-y-6">
            {labels.faq.map((item) => <div className="space-y-2" key={item.question}>
              <dt className="text-base font-medium">{item.question}</dt>
              <dd className="text-sm leading-7 text-[var(--bb-muted)]">{item.answer}</dd>
            </div>)}
          </dl>
          <a className="mt-5 inline-flex min-h-11 items-center text-sm font-medium text-[var(--bb-primary)] underline underline-offset-4" href="#contents">{labels.backToContents}</a>
        </section>
      </div>
    </main>
  );
}
