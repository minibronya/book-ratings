"use client";

import { BookTable } from "@/components/BookTable";

type Props = {
  currentYear: number;
};

export function BookDashboard({ currentYear }: Props) {
  return (
    <section className="dashboard">
      <BookTable
        title="Book rankings"
        description="Sort and filter books by Hardcover reader ratings and Book Marks critic scores."
        currentYear={currentYear}
      />
    </section>
  );
}
