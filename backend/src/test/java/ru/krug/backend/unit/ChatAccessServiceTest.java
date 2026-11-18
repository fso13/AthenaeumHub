package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.chat.application.usecase.ChatAccessService;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * Application-level authorisation rules: 403 wins for a foreign workspace, a chat without
 * active membership is hidden as 404.
 */
class ChatAccessServiceTest {

    private final WorkspaceAccessPort workspaceAccess = mock(WorkspaceAccessPort.class);
    private final ChatRepository chatRepository = mock(ChatRepository.class);
    private final ChatAccessService service = new ChatAccessService(workspaceAccess,
            chatRepository);

    private final UUID workspaceId = UUID.randomUUID();
    private final UUID chatId = UUID.randomUUID();
    private final UUID userId = UUID.randomUUID();

    @Test
    void deniesWith403WhenWorkspaceMembershipIsMissing() {
        org.mockito.Mockito.doThrow(DomainException.forbidden("No access"))
                .when(workspaceAccess).requireActiveMember(workspaceId, userId);

        assertThatThrownBy(() -> service.requireActiveChat(workspaceId, chatId, userId))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.category().name()).isEqualTo("FORBIDDEN"));
    }

    @Test
    void hidesChatWith404WhenChatIsAbsent() {
        when(chatRepository.findById(workspaceId, chatId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.requireActiveChat(workspaceId, chatId, userId))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.category().name()).isEqualTo("NOT_FOUND"));
    }

    @Test
    void hidesChatWith404WhenMembershipIsNotActive() {
        when(chatRepository.findById(workspaceId, chatId)).thenReturn(Optional.of(
                Chat.createManagedGroup(chatId, workspaceId, userId, "group")));
        when(chatRepository.findMember(chatId, userId)).thenReturn(Optional.of(
                ChatMember.reconstitute(chatId, userId, ChatMember.Role.MEMBER,
                        ChatMember.Status.INVITED)));

        assertThatThrownBy(() -> service.requireActiveChat(workspaceId, chatId, userId))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.category().name()).isEqualTo("NOT_FOUND"));
    }

    @Test
    void returnsAccessForAnActiveMember() {
        when(chatRepository.findById(workspaceId, chatId)).thenReturn(Optional.of(
                Chat.createManagedGroup(chatId, workspaceId, userId, "group")));
        when(chatRepository.findMember(chatId, userId)).thenReturn(Optional.of(
                ChatMember.reconstitute(chatId, userId, ChatMember.Role.MEMBER,
                        ChatMember.Status.ACTIVE)));
        when(chatRepository.lastSeq(chatId)).thenReturn(7L);

        ChatAccess access = service.requireActiveChat(workspaceId, chatId, userId);
        assertThat(access.chatId()).isEqualTo(chatId);
        assertThat(access.memberRole()).isEqualTo("MEMBER");
        assertThat(access.lastSeq()).isEqualTo(7L);
    }
}
