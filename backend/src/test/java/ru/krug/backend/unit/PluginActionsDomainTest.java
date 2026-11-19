package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.plugin.domain.model.ChatTask;
import ru.krug.backend.plugin.domain.model.Poll;
import ru.krug.backend.plugin.domain.service.PluginTextPolicy;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/** Domain rules for #76 poll/task/translation actions (no Spring, no DB). */
class PluginActionsDomainTest {

    private static final Instant NOW = Instant.parse("2026-11-19T12:00:00Z");

    @Test
    void pollCreateTrimsQuestionAndOptionsAndKeepsViewerFieldsEmpty() {
        Poll poll = Poll.create(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                "  Lunch?  ", List.of("  Pizza ", "Sushi"), NOW, UUID::randomUUID);

        assertThat(poll.question()).isEqualTo("Lunch?");
        assertThat(poll.options()).extracting(option -> option.text())
                .containsExactly("Pizza", "Sushi");
        assertThat(poll.options()).extracting(option -> option.position())
                .containsExactly(0, 1);
        assertThat(poll.options()).extracting(option -> option.votes()).containsExactly(0L, 0L);
        assertThat(poll.closed()).isFalse();
        assertThat(poll.closedAt()).isNull();
        assertThat(poll.myOptionId()).isNull();
        assertThat(poll.totalVotes()).isZero();
        assertThat(poll.options().get(0).id()).isNotEqualTo(poll.options().get(1).id());
        assertThat(poll.isCreator(poll.creatorId())).isTrue();
        assertThat(poll.hasOption(poll.options().get(0).id())).isTrue();
        assertThat(poll.hasOption(UUID.randomUUID())).isFalse();
    }

    @Test
    void pollRejectsInvalidOptionSets() {
        UUID workspace = UUID.randomUUID();
        UUID chat = UUID.randomUUID();
        UUID creator = UUID.randomUUID();

        assertThatThrownBy(() -> Poll.create(workspace, chat, creator, "Q",
                List.of("one"), NOW, UUID::randomUUID))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> Poll.create(workspace, chat, creator, "Q",
                List.of("same", "same"), NOW, UUID::randomUUID))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> Poll.create(workspace, chat, creator, "<b>Q</b>",
                List.of("a", "b"), NOW, UUID::randomUUID))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> Poll.create(workspace, chat, creator, "Q",
                List.of("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"), NOW,
                UUID::randomUUID))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> Poll.create(workspace, chat, creator, "   ",
                List.of("a", "b"), NOW, UUID::randomUUID))
                .isInstanceOf(DomainException.class);
    }

    @Test
    void taskCompletionPermissionIsCreatorAssigneeOrChatManager() {
        UUID owner = UUID.randomUUID();
        UUID assignee = UUID.randomUUID();
        UUID stranger = UUID.randomUUID();
        ChatTask task = ChatTask.create(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                owner, assignee, "  Prepare report  ", NOW.plusSeconds(3600), NOW);

        assertThat(task.title()).isEqualTo("Prepare report");
        assertThat(task.done()).isFalse();
        assertThat(task.canChangeDone(owner, "MEMBER")).isTrue();
        assertThat(task.canChangeDone(assignee, "MEMBER")).isTrue();
        assertThat(task.canChangeDone(stranger, "OWNER")).isTrue();
        assertThat(task.canChangeDone(stranger, "ADMIN")).isTrue();
        assertThat(task.canChangeDone(stranger, "MODERATOR")).isFalse();
        assertThat(task.canChangeDone(stranger, "MEMBER")).isFalse();

        ChatTask done = task.withDone(true, assignee, NOW.plusSeconds(1));
        assertThat(done.done()).isTrue();
        assertThat(done.completedBy()).isEqualTo(assignee);
        assertThat(done.completedAt()).isEqualTo(NOW.plusSeconds(1));
        assertThat(task.done()).isFalse();

        ChatTask reopened = done.withDone(false, owner, NOW.plusSeconds(2));
        assertThat(reopened.done()).isFalse();
        assertThat(reopened.completedBy()).isNull();
        assertThat(reopened.completedAt()).isNull();
    }

    @Test
    void translationPolicyIsPlainTextBoundedAndLanguageCodeValidated() {
        assertThat(PluginTextPolicy.requireTranslated("  Привет\r\nмир  "))
                .isEqualTo("Привет\nмир");
        assertThat(PluginTextPolicy.requireTranslated("emoji 😀 and\ttab"))
                .isEqualTo("emoji 😀 and\ttab");

        assertThatThrownBy(() -> PluginTextPolicy.requireTranslated("<script>x</script>"))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.TRANSLATION_UNAVAILABLE));
        assertThatThrownBy(() -> PluginTextPolicy.requireTranslated("   "))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> PluginTextPolicy.requireTranslated("a\u0000b"))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> PluginTextPolicy.requireTranslated("x".repeat(8001)))
                .isInstanceOf(DomainException.class);

        assertThat(PluginTextPolicy.requireTargetLanguage(" ru ")).isEqualTo("ru");
        assertThat(PluginTextPolicy.requireTargetLanguage("pt-BR")).isEqualTo("pt-BR");
        assertThatThrownBy(() -> PluginTextPolicy.requireTargetLanguage("ru_RU"))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> PluginTextPolicy.requireTargetLanguage("r"))
                .isInstanceOf(DomainException.class);
    }
}
