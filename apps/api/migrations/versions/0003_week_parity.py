"""week parity — alternating-week assignments

Revision ID: 0003
Revises: 0002
Create Date: slice 2, phase 1

chore_assignments could say "Panashe deep-cleans the living room every Saturday".
It could not say "every OTHER Saturday", which is what the Saturday deep clean
needs: the adults swap two zones between them week to week, and the boys swap
theirs.

THIS IS NOT THE ROTATION THE DESIGN RULES OUT, and the distinction is the whole
argument for the column. week_parity is COMPUTED FROM THE DUE DATE, exactly like
day_of_week — nothing advances, nothing is stored about last week, nothing is
updated when a chore is completed. The board answers "whose week is it?" from the
calendar alone. What stays unrepresentable is STATE: there is still no
rotation_index, no last_assigned_to, no next_up, no counter that materialization
increments. "Whose turn was it?" is the question this system exists to end;
"what does the date say?" is not that question.

WHY ORDINAL DIVISION AND NOT THE ISO WEEK NUMBER. ISO week numbers are
discontinuous at the year boundary — week 52 can be followed by week 1, giving
two odd weeks in a row. Reproduced on real dates: 2026-12-26, 2027-01-02 and
2027-01-09 have ISO-week parities 0, 1, 1, so on the second Saturday of January
everyone's zones would silently fail to swap and nobody would know why.
(due_date.toordinal() // 7) % 2 is continuous forever.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable: every assignment that exists means "every week", with no backfill
    # and no behaviour change for anything already scheduled.
    op.execute(
        """
        alter table chore_assignments
            add column week_parity smallint check (week_parity in (0, 1))
        """
    )
    op.execute(
        """
        comment on column chore_assignments.week_parity is
            'null = every week. 0/1 = alternating weeks, computed as (due_date.toordinal() // 7) % 2. NOT the ISO week number, which repeats parity at the year boundary. The parity block runs Sunday..Saturday.'
        """
    )

    # The unique constraint (definition_id, member_id, day_of_week) is DELIBERATELY
    # left alone. Adding week_parity to it would permit a null row AND a 0 row for
    # the same person, day and definition — a contradictory pair in which the null
    # silently wins and the 0 row is dead weight nobody can see. Leaving it out
    # makes that unrepresentable.
    #
    # The real schedule still fits, because alternation always differs by
    # member_id (Panashe Sat/0, Priscilla Sat/1) or by day_of_week (LD
    # Mon-Wed-Fri/null plus LD Sun/0).
    #
    # No new index either: chore_assignments (day_of_week) still carries the
    # materializer's lookup, and the table is around a hundred rows.


def downgrade() -> None:
    op.execute("alter table chore_assignments drop column week_parity")
