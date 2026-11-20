package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;

import org.junit.jupiter.api.Test;

import ru.krug.backend.message.domain.model.SearchHighlight;
import ru.krug.backend.message.domain.service.SearchSnippet;

/** #83 snippet/highlight builder: plain text only, case-insensitive literal match. */
class SearchSnippetTest {

    @Test
    void highlightsEveryLiteralMatchCaseInsensitively() {
        SearchSnippet.Result result = SearchSnippet.build("Alpha beta ALPHA gamma alpha", "alpha",
                240);

        assertThat(result).isNotNull();
        assertThat(result.text()).isEqualTo("Alpha beta ALPHA gamma alpha");
        assertThat(result.highlights()).hasSize(3);
        for (SearchHighlight highlight : result.highlights()) {
            assertThat(result.text().substring(highlight.start(), highlight.end()).toLowerCase())
                    .isEqualTo("alpha");
        }
    }

    @Test
    void centresALongMessageAndKeepsOffsetsConsistent() {
        String text = "x".repeat(400) + " needle " + "y".repeat(400);
        SearchSnippet.Result result = SearchSnippet.build(text, "needle", 60);

        assertThat(result).isNotNull();
        assertThat(result.text()).hasSizeLessThanOrEqualTo(62); // window + two ellipses
        assertThat(result.text()).startsWith(SearchSnippet.ELLIPSIS);
        assertThat(result.text()).endsWith(SearchSnippet.ELLIPSIS);
        assertThat(result.highlights()).hasSize(1);
        SearchHighlight highlight = result.highlights().get(0);
        assertThat(result.text().substring(highlight.start(), highlight.end()))
                .isEqualTo("needle");
    }

    @Test
    void returnsNullWhenTheTextDoesNotContainTheQuery() {
        assertThat(SearchSnippet.build("hello world", "absent", 100)).isNull();
        assertThat(SearchSnippet.build(null, "x", 100)).isNull();
        assertThat(SearchSnippet.build("hello", "", 100)).isNull();
    }

    @Test
    void treatsRegexCharactersLiterally() {
        assertThat(SearchSnippet.build("a.b*c", ".*", 100)).isNull();
        SearchSnippet.Result result = SearchSnippet.build("cost is $5", "$5", 100);
        assertThat(result).isNotNull();
        assertThat(result.highlights()).containsExactly(new SearchHighlight(8, 10));
    }

    @Test
    void neverReturnsHtmlMarkup() {
        SearchSnippet.Result result = SearchSnippet.build("<b>alpha</b>", "alpha", 100);
        assertThat(result).isNotNull();
        assertThat(result.text()).isEqualTo("<b>alpha</b>");
        assertThat(List.copyOf(result.highlights())).isNotEmpty();
    }
}
