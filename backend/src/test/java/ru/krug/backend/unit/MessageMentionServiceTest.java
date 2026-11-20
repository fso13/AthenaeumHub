package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import ru.krug.backend.chat.application.model.ChatDirectorySnapshot;
import ru.krug.backend.chat.application.port.ChatMemberDirectoryPort;
import ru.krug.backend.message.application.model.MentionPlan;
import ru.krug.backend.message.application.usecase.MessageMentionService;
import ru.krug.backend.message.domain.model.MessageMention;
import ru.krug.backend.message.domain.repository.MessageMentionRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;

/** #83 mention validation: active membership, @all roles, dedupe and recipient exclusions. */
class MessageMentionServiceTest {

    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final UUID CHAT = UUID.randomUUID();
    private static final UUID SENDER = UUID.randomUUID();
    private static final UUID MEMBER = UUID.randomUUID();
    private static final UUID SECOND = UUID.randomUUID();

    private ChatMemberDirectoryPort directory;
    private MessageMentionRepository repository;
    private MessageMentionService service;
    private Principal principal;

    @BeforeEach
    void setUp() {
        directory = mock(ChatMemberDirectoryPort.class);
        repository = mock(MessageMentionRepository.class);
        service = new MessageMentionService(directory, repository);
        principal = new Principal(SENDER, UUID.randomUUID(), WORKSPACE, "request");
        when(directory.find(WORKSPACE, CHAT)).thenReturn(Optional.of(
                new ChatDirectorySnapshot(CHAT, WORKSPACE, "chat", false,
                        List.of(SENDER, MEMBER, SECOND))));
    }

    @Test
    void acceptsExplicitActiveMembersAndExcludesTheSender() {
        MentionPlan plan = service.plan(principal, WORKSPACE, CHAT, "MEMBER",
                List.of(MEMBER, MEMBER), false);

        assertThat(plan.mentionedUserIds()).containsExactly(MEMBER);
        assertThat(plan.recipientIds()).containsExactly(MEMBER);
        assertThat(plan.all()).isFalse();
        assertThat(plan.hasMentions()).isTrue();
    }

    @Test
    void rejectsIdsThatAreNotActiveChatMembers() {
        UUID outsider = UUID.randomUUID();
        assertThatThrownBy(() -> service.plan(principal, WORKSPACE, CHAT, "MEMBER",
                List.of(outsider), false))
                .isInstanceOf(DomainException.class)
                .satisfies(error -> assertThat(((DomainException) error).code())
                        .isEqualTo("MENTION_INVALID"));
    }

    @Test
    void allRequiresOwnerOrAdminAndNotifiesEveryActiveMemberExceptTheSender() {
        assertThatThrownBy(() -> service.plan(principal, WORKSPACE, CHAT, "MEMBER",
                List.of(), true))
                .isInstanceOf(DomainException.class)
                .satisfies(error -> {
                    assertThat(((DomainException) error).code())
                            .isEqualTo("MENTION_ALL_FORBIDDEN");
                    assertThat(((DomainException) error).category().name()).isEqualTo("FORBIDDEN");
                });

        MentionPlan plan = service.plan(principal, WORKSPACE, CHAT, "ADMIN", List.of(), true);
        assertThat(plan.all()).isTrue();
        assertThat(plan.recipientIds()).containsExactly(MEMBER, SECOND);
        assertThat(plan.mentionedUserIds()).isEmpty();
    }

    @Test
    void capsTheNumberOfExplicitIds() {
        List<UUID> ids = new ArrayList<>();
        for (int i = 0; i < 51; i++) {
            ids.add(UUID.randomUUID());
        }
        assertThatThrownBy(() -> service.plan(principal, WORKSPACE, CHAT, "OWNER", ids, false))
                .isInstanceOf(DomainException.class)
                .satisfies(error -> assertThat(((DomainException) error).code())
                        .isEqualTo("VALIDATION_FAILED"));
    }

    @Test
    void recordsOneRowPerRecipientWithTheAllMarker() {
        MentionPlan plan = service.plan(principal, WORKSPACE, CHAT, "OWNER", List.of(), true);
        Instant now = Instant.parse("2026-01-01T10:00:00Z");
        UUID messageId = UUID.randomUUID();

        service.record(WORKSPACE, CHAT, messageId, plan, now);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<MessageMention>> captor = ArgumentCaptor.forClass(List.class);
        verify(repository).saveAll(captor.capture());
        assertThat(captor.getValue()).hasSize(2);
        assertThat(captor.getValue()).allSatisfy(row -> {
            assertThat(row.messageId()).isEqualTo(messageId);
            assertThat(row.chatId()).isEqualTo(CHAT);
            assertThat(row.mentionAll()).isTrue();
            assertThat(row.isRead()).isFalse();
        });
    }

    @Test
    void anEmptyPlanWritesNothing() {
        MentionPlan plan = service.plan(principal, WORKSPACE, CHAT, "MEMBER", List.of(), false);
        service.record(WORKSPACE, CHAT, UUID.randomUUID(), plan, Instant.now());
        verify(repository, never()).saveAll(any());
    }
}
