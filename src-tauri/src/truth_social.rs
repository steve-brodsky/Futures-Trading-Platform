use crate::AppError;
use chrono::DateTime;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const FEED_URL: &str = "https://rollcall.com/wp-json/factbase/v1/twitter?platform=truth%20social&sort=date&sort_order=desc&page=1&format=json";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TruthSocialPost {
    pub id: String,
    pub published_at: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    pub post_url: String,
    pub handle: String,
    pub platform: String,
    pub deleted: bool,
    pub is_repost: bool,
}

#[derive(Debug, Deserialize)]
struct Feed {
    data: Option<Vec<FeedPost>>,
}

#[derive(Debug, Deserialize)]
struct FeedPost {
    id: Option<String>,
    document_id: Option<String>,
    date: Option<String>,
    text: Option<String>,
    image_url: Option<String>,
    post_url: Option<String>,
    handle: Option<String>,
    platform: Option<String>,
    #[serde(default)]
    deleted_flag: bool,
    social: Option<SocialFields>,
}

#[derive(Debug, Deserialize)]
struct SocialFields {
    post_text: Option<String>,
    #[serde(default)]
    repost_flag: bool,
}

pub fn validate_post_url(value: &str) -> Result<url::Url, AppError> {
    let url = url::Url::parse(value)?;
    if url.scheme() != "https" || url.host_str() != Some("truthsocial.com") {
        return Err(AppError::Validation(
            "Truth Social links must use https://truthsocial.com".into(),
        ));
    }
    Ok(url)
}

pub fn parse_feed(value: &str) -> Result<Vec<TruthSocialPost>, AppError> {
    let feed: Feed = serde_json::from_str(value)?;
    let data = feed.data.ok_or_else(|| {
        AppError::Api("Roll Call Truth Social feed structure was not recognized".into())
    })?;
    let had_records = !data.is_empty();
    let posts = data
        .into_iter()
        .filter_map(|post| {
            let id = post.id.or(post.document_id)?.trim().to_string();
            let published_at = post.date?.trim().to_string();
            let post_url = post.post_url?.trim().to_string();
            let handle = post.handle?.trim().to_string();
            let platform = post.platform?.trim().to_string();
            if id.is_empty()
                || handle.is_empty()
                || platform.is_empty()
                || DateTime::parse_from_rfc3339(&published_at).is_err()
                || validate_post_url(&post_url).is_err()
            {
                return None;
            }
            let social = post.social;
            let text = social
                .as_ref()
                .and_then(|fields| fields.post_text.as_deref())
                .or(post.text.as_deref())
                .unwrap_or("")
                .trim()
                .to_string();
            Some(TruthSocialPost {
                id,
                published_at,
                text,
                image_url: post.image_url.filter(|value| value.starts_with("https://")),
                post_url,
                handle,
                platform,
                deleted: post.deleted_flag,
                is_repost: social.is_some_and(|fields| fields.repost_flag),
            })
        })
        .collect::<Vec<_>>();
    if posts.is_empty() && had_records {
        return Err(AppError::Api(
            "Roll Call returned no recognizable Truth Social posts".into(),
        ));
    }
    Ok(posts)
}

pub async fn fetch_latest() -> Result<Vec<TruthSocialPost>, AppError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("NorthstarTrader/0.1 (+private desktop catalyst alerts)")
        .build()?;
    let response = client.get(FEED_URL).send().await?.error_for_status()?;
    parse_feed(&response.text().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_media_and_repost_fields() {
        let posts = parse_feed(r#"{
          "data": [{
            "id": "117072168149236615",
            "date": "2026-08-10T12:31:58-04:00",
            "text": "fallback",
            "image_url": "https://media-cdn.rollcall.com/post.jpg",
            "post_url": "https://truthsocial.com/@realDonaldTrump/posts/117072168149236615",
            "handle": "realDonaldTrump",
            "platform": "Truth Social",
            "deleted_flag": false,
            "social": { "post_text": "Normalized post", "repost_flag": true }
          }]
        }"#).unwrap();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].text, "Normalized post");
        assert!(posts[0].is_repost);
        assert_eq!(posts[0].published_at, "2026-08-10T12:31:58-04:00");
    }

    #[test]
    fn rejects_changed_or_unrecognizable_feed_shapes() {
        assert!(parse_feed(r#"{"items":[]}"#).unwrap_err().to_string().contains("structure"));
        assert!(parse_feed(r#"{"data":[{"id":"broken"}]}"#).unwrap_err().to_string().contains("recognizable"));
        assert!(parse_feed(r#"{"data":[]}"#).unwrap().is_empty());
    }

    #[test]
    fn allows_only_truth_social_https_links() {
        assert!(validate_post_url("https://truthsocial.com/@realDonaldTrump/posts/1").is_ok());
        assert!(validate_post_url("http://truthsocial.com/@realDonaldTrump/posts/1").is_err());
        assert!(validate_post_url("https://evil.example/posts/1").is_err());
        assert!(validate_post_url("https://truthsocial.com.evil.example/posts/1").is_err());
    }
}
