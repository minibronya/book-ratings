"use client";

import { BookTable } from "@/components/BookTable";

type Props = {
  latestUpdate: string | null;
};

export function BookDashboard({ latestUpdate }: Props) {
  return (
    <section className="dashboard">
      <BookTable
        title="Book rankings"
        description="Sort and filter books by Goodreads reader ratings and Book Marks critic scores."
        latestUpdate={latestUpdate}
      />
    </section>
  );
}
