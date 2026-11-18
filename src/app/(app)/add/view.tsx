import { AccountingInput } from "@/components/accounting-input";
import { LedgerEntrySelector } from "@/components/ledger-switcher";
import { Reveal } from "@/components/motion-primitives";
import { getMessages } from "@/lib/i18n";
import styles from "@/components/finance-b2.module.css";
import type { loadAddPage } from "./loader";


export function AddView({ data }: { data: Awaited<ReturnType<typeof loadAddPage>> }) {
  const { locale, form } = data;
  const messages = getMessages(locale);
  const user = { memberId: form.currentMemberId }; const context = form.context; const transactionFormProps = { ...form, locale, labels: { add: { checkRecords: messages.add.checkRecords, retryConfirmation: messages.add.retryConfirmation, save: messages.add.save, slowSaving: messages.add.slowSaving, successMessage: messages.add.successMessage, unknownDescription: messages.add.unknownDescription, unknownTitle: messages.add.unknownTitle }, common: messages.common } };
  return (
    <section className={`${styles.compose} space-y-4`}>
      <div aria-hidden="true" className={styles.composeHandle} />
      <Reveal>
        <header className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="bb-section-title">{messages.add.title}</h1>
          </div>
        </header>
      </Reveal>
      <LedgerEntrySelector locale={locale} />
      <AccountingInput {...transactionFormProps} key={`${user.memberId}:${context.ledgerId}`} />
    </section>
  );
}
