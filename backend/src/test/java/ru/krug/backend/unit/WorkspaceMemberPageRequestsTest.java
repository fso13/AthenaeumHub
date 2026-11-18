package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.model.WorkspaceMemberPageCursor;
import ru.krug.backend.workspace.application.service.WorkspaceMemberPageRequests;
import ru.krug.backend.workspace.domain.exception.InvalidWorkspaceMemberCursorException;

/** E10-B request validation: default/explicit limits, literal query, blank cursor. */
class WorkspaceMemberPageRequestsTest {

    @Test
    void limitDefaultsTo50AndAcceptsTheInclusiveRange() {
        assertThat(WorkspaceMemberPageRequests.limit(null)).isEqualTo(50);
        assertThat(WorkspaceMemberPageRequests.limit(1)).isEqualTo(1);
        assertThat(WorkspaceMemberPageRequests.limit(100)).isEqualTo(100);
    }

    @Test
    void limitOutsideOneToHundredIsRejected() {
        assertThatThrownBy(() -> WorkspaceMemberPageRequests.limit(0))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> WorkspaceMemberPageRequests.limit(101))
                .isInstanceOf(DomainException.class);
    }

    @Test
    void queryIsTrimmedButPercentAndUnderscoreStayLiteral() {
        assertThat(WorkspaceMemberPageRequests.query(null)).isNull();
        assertThat(WorkspaceMemberPageRequests.query("   ")).isNull();
        assertThat(WorkspaceMemberPageRequests.query("  Иван  ")).isEqualTo("Иван");
        assertThat(WorkspaceMemberPageRequests.query("%_")).isEqualTo("%_");
    }

    @Test
    void queryLongerThanTheDisplayNameLimitIsRejected() {
        assertThatThrownBy(() -> WorkspaceMemberPageRequests.query("x".repeat(81)))
                .isInstanceOf(DomainException.class);
    }

    @Test
    void blankCursorMeansFirstPageAndGarbageIsRejected() {
        UUID workspaceId = UUID.randomUUID();
        assertThat(WorkspaceMemberPageRequests.cursor(null, workspaceId)).isNull();
        assertThat(WorkspaceMemberPageRequests.cursor("   ", workspaceId)).isNull();
        assertThatThrownBy(() -> WorkspaceMemberPageRequests.cursor("garbage", workspaceId))
                .isInstanceOf(InvalidWorkspaceMemberCursorException.class);
    }

    @Test
    void cursorRoundTripsThroughTheRequestHelper() {
        UUID workspaceId = UUID.randomUUID();
        WorkspaceMemberPageCursor cursor = new WorkspaceMemberPageCursor(workspaceId,
                "Иван", UUID.randomUUID());

        assertThat(WorkspaceMemberPageRequests.cursor(cursor.encode(), workspaceId))
                .isEqualTo(cursor);
    }
}
