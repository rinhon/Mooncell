from app.providers.tmdb import (
    parse_tmdb_detail_html,
    parse_tmdb_image_page,
    parse_tmdb_search_html,
)


def test_parse_tmdb_search_results() -> None:
    html = """
    <section class="panel"><div class="search_results tv"><div class="results flex">
      <div class="media-card-list">
        <div class="comp:media-card">
          <a data-media-type="tv" href="/tv/30984-bleach?language=zh-CN">
            <img class="poster" src="https://media.example/bleach.jpg">
          </a>
          <a href="/tv/30984-bleach?language=zh-CN">
            <h2><span>死神</span><span> (BLEACH)</span></h2>
          </a>
          <span class="release_date">2004 年 10 月 05 日</span>
          <div class="mt-4"><p>故事简介</p></div>
        </div>
      </div>
    </div></div></section>
    """
    results = parse_tmdb_search_html(html)
    assert len(results) == 1
    assert results[0].tmdb_id == 30984
    assert results[0].media_type == "tv"
    assert results[0].title == "死神"
    assert results[0].original_title == "BLEACH"
    assert results[0].href == "https://www.themoviedb.org/tv/30984-bleach?language=zh-CN"


def test_parse_tmdb_json_ld_detail() -> None:
    html = """
    <script type="application/ld+json">
    /* <![CDATA[ */
    {"@type":"TVSeries","name":"死神","description":"故事简介",\
"image":"https://image.tmdb.org/poster.jpg","startDate":"2004-10-05T00:00:00Z",\
"numberOfEpisodes":416,"genre":["动画","动作冒险"],\
"aggregateRating":{"ratingValue":8.4,"ratingCount":2243},\
"url":"https://www.themoviedb.org/tv/30984-bleach"}
    /* ]]> */
    </script>
    """
    result = parse_tmdb_detail_html(html, 30984, "tv")
    assert result.tmdb_id == 30984
    assert result.title == "死神"
    assert result.release_date == "2004-10-05"
    assert result.episode_count == 416
    assert result.rating == 8.4
    assert result.genres == ["动画", "动作冒险"]


def test_parse_tmdb_image_page_returns_first_original() -> None:
    html = """
    <ul class="images backdrops">
      <li><a href="https://image.tmdb.org/t/p/original/first.jpg">第一张</a></li>
      <li><a href="https://image.tmdb.org/t/p/original/second.jpg">第二张</a></li>
    </ul>
    """
    assert parse_tmdb_image_page(html) == "https://image.tmdb.org/t/p/original/first.jpg"
