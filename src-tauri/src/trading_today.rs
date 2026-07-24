use crate::{storage, AppError};
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use chrono_tz::America::New_York;
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path, time::Duration};

const CACHE_KEY: &str = "trading_today_cache";
pub const CALENDAR_URL: &str = "https://tradingeconomics.com/united-states/calendar";
pub const NYSE_URL: &str = "https://www.nyse.com/markets/hours-calendars";
pub const CME_URL: &str = "https://www.cmegroup.com/trading-hours.html";
const HOLIDAY_VERIFIED_THROUGH: &str = "2026-12-31";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EconomicEvent {
    pub id: String,
    pub occurs_at: String,
    pub title: String,
    pub reference: Option<String>,
    pub importance: Option<u8>,
    pub actual: Option<String>,
    pub consensus: Option<String>,
    pub previous: Option<String>,
    pub forecast: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarketHolidayVenueStatus {
    pub venue: String,
    pub status: String,
    pub detail: String,
    pub source_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarketHoliday {
    pub date: String,
    pub name: String,
    pub venues: Vec<MarketHolidayVenueStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TradingTodaySnapshot {
    pub date: String,
    pub timezone: String,
    pub fetched_at: String,
    pub status: String,
    pub events: Vec<EconomicEvent>,
    pub holidays: Vec<MarketHoliday>,
    pub source_url: String,
    pub holiday_verified_through: String,
}

#[derive(Clone, Copy)]
struct HolidayEntry {
    date: &'static str,
    name: &'static str,
    venue: &'static str,
    status: &'static str,
    detail: &'static str,
    source_url: &'static str,
}

macro_rules! nyse {
    ($date:literal, $name:literal, $status:literal, $detail:literal) => {
        HolidayEntry {
            date: $date,
            name: $name,
            venue: "NYSE",
            status: $status,
            detail: $detail,
            source_url: NYSE_URL,
        }
    };
}

macro_rules! cme {
    ($date:literal, $name:literal) => {
        HolidayEntry {
            date: $date,
            name: $name,
            venue: "CME",
            status: "modified-hours",
            detail: "Modified schedule · check product hours",
            source_url: CME_URL,
        }
    };
}

const HOLIDAYS: &[HolidayEntry] = &[
    // NYSE 2026 closures and published early closes.
    nyse!("2026-01-01", "New Year's Day", "closed", "Market closed"),
    nyse!("2026-01-19", "Martin Luther King Jr. Day", "closed", "Market closed"),
    nyse!("2026-02-16", "Washington's Birthday", "closed", "Market closed"),
    nyse!("2026-04-03", "Good Friday", "closed", "Market closed"),
    nyse!("2026-05-25", "Memorial Day", "closed", "Market closed"),
    nyse!("2026-06-19", "Juneteenth", "closed", "Market closed"),
    nyse!("2026-07-03", "Independence Day (observed)", "closed", "Market closed"),
    nyse!("2026-09-07", "Labor Day", "closed", "Market closed"),
    nyse!("2026-11-26", "Thanksgiving Day", "closed", "Market closed"),
    nyse!("2026-11-27", "Day after Thanksgiving", "early-close", "Closes 1:00 PM ET"),
    nyse!("2026-12-24", "Christmas Eve", "early-close", "Closes 1:00 PM ET"),
    nyse!("2026-12-25", "Christmas Day", "closed", "Market closed"),
    // NYSE 2027.
    nyse!("2027-01-01", "New Year's Day", "closed", "Market closed"),
    nyse!("2027-01-18", "Martin Luther King Jr. Day", "closed", "Market closed"),
    nyse!("2027-02-15", "Washington's Birthday", "closed", "Market closed"),
    nyse!("2027-03-26", "Good Friday", "closed", "Market closed"),
    nyse!("2027-05-31", "Memorial Day", "closed", "Market closed"),
    nyse!("2027-06-18", "Juneteenth (observed)", "closed", "Market closed"),
    nyse!("2027-07-05", "Independence Day (observed)", "closed", "Market closed"),
    nyse!("2027-09-06", "Labor Day", "closed", "Market closed"),
    nyse!("2027-11-25", "Thanksgiving Day", "closed", "Market closed"),
    nyse!("2027-11-26", "Day after Thanksgiving", "early-close", "Closes 1:00 PM ET"),
    nyse!("2027-12-24", "Christmas Day (observed)", "closed", "Market closed"),
    // NYSE 2028.
    nyse!("2028-01-17", "Martin Luther King Jr. Day", "closed", "Market closed"),
    nyse!("2028-02-21", "Washington's Birthday", "closed", "Market closed"),
    nyse!("2028-04-14", "Good Friday", "closed", "Market closed"),
    nyse!("2028-05-29", "Memorial Day", "closed", "Market closed"),
    nyse!("2028-06-19", "Juneteenth", "closed", "Market closed"),
    nyse!("2028-07-03", "Independence Day eve", "early-close", "Closes 1:00 PM ET"),
    nyse!("2028-07-04", "Independence Day", "closed", "Market closed"),
    nyse!("2028-09-04", "Labor Day", "closed", "Market closed"),
    nyse!("2028-11-23", "Thanksgiving Day", "closed", "Market closed"),
    nyse!("2028-11-24", "Day after Thanksgiving", "early-close", "Closes 1:00 PM ET"),
    nyse!("2028-12-25", "Christmas Day", "closed", "Market closed"),
    // CME's currently published 2026 U.S. holiday schedule. Product hours vary.
    cme!("2026-01-01", "New Year's Day"),
    cme!("2026-01-19", "Martin Luther King Jr. Day"),
    cme!("2026-02-16", "Presidents Day"),
    cme!("2026-04-03", "Good Friday"),
    cme!("2026-05-25", "Memorial Day"),
    cme!("2026-06-19", "Juneteenth"),
    cme!("2026-07-03", "Independence Day (observed)"),
    cme!("2026-09-07", "Labor Day"),
    cme!("2026-11-26", "Thanksgiving Day"),
    cme!("2026-11-27", "Day after Thanksgiving"),
    cme!("2026-12-24", "Christmas Eve"),
    cme!("2026-12-25", "Christmas Day"),
];

fn selector(value: &str) -> Result<Selector, AppError> {
    Selector::parse(value)
        .map_err(|_| AppError::Api(format!("Trading Economics selector is invalid: {value}")))
}

fn compact_text(element: ElementRef<'_>) -> String {
    element
        .text()
        .flat_map(str::split_whitespace)
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn optional_text(element: ElementRef<'_>, selector: &Selector) -> Option<String> {
    element
        .select(selector)
        .next()
        .map(compact_text)
        .filter(|value| !value.is_empty())
}

fn date_from_cell(cell: ElementRef<'_>) -> Option<NaiveDate> {
    cell.value()
        .attr("class")?
        .split_whitespace()
        .find_map(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
}

fn importance_from_cell(cell: ElementRef<'_>) -> Option<u8> {
    let span = cell.select(&Selector::parse("span").ok()?).next()?;
    span.value()
        .classes()
        .find_map(|class| class.strip_prefix("calendar-date-")?.parse::<u8>().ok())
        .filter(|value| (1..=3).contains(value))
}

pub fn parse_calendar(html: &str, requested_date: &str) -> Result<Vec<EconomicEvent>, AppError> {
    let requested = NaiveDate::parse_from_str(requested_date, "%Y-%m-%d")
        .map_err(|_| AppError::Validation("Trading Today date must use YYYY-MM-DD".into()))?;
    let document = Html::parse_document(html);
    let table_selector = selector("table#calendar")?;
    let row_selector = selector("table#calendar tr[data-country='united states']")?;
    let event_selector = selector("a.calendar-event")?;
    let reference_selector = selector(".calendar-reference")?;
    let actual_selector = selector("[id='actual']")?;
    let previous_selector = selector("[id='previous']")?;
    let consensus_selector = selector("[id='consensus']")?;
    let forecast_selector = selector("[id='forecast']")?;

    if document.select(&table_selector).next().is_none() {
        return Err(AppError::Api(
            "Trading Economics calendar markup was not recognized".into(),
        ));
    }

    let mut seen_dates = Vec::new();
    let mut events = Vec::new();
    for row in document.select(&row_selector) {
        let cells = row
            .children()
            .filter_map(ElementRef::wrap)
            .filter(|child| child.value().name() == "td")
            .collect::<Vec<_>>();
        if cells.len() < 7 {
            continue;
        }
        let Some(source_date) = date_from_cell(cells[0]) else {
            continue;
        };
        seen_dates.push(source_date);
        let time_text = compact_text(cells[0]);
        let Ok(source_time) = NaiveTime::parse_from_str(&time_text, "%I:%M %p") else {
            continue;
        };
        let utc = DateTime::<Utc>::from_naive_utc_and_offset(
            NaiveDateTime::new(source_date, source_time),
            Utc,
        );
        if utc.with_timezone(&New_York).date_naive() != requested {
            continue;
        }

        let reference = optional_text(cells[2], &reference_selector);
        let title = optional_text(cells[2], &event_selector).unwrap_or_else(|| {
            let cell_text = compact_text(cells[2]);
            reference
                .as_deref()
                .and_then(|reference| cell_text.strip_suffix(reference))
                .unwrap_or(&cell_text)
                .trim()
                .to_string()
        });
        if title.is_empty() {
            continue;
        }
        let relative_url = row
            .value()
            .attr("data-url")
            .or_else(|| cells[2].select(&event_selector).next().and_then(|item| item.value().attr("href")));
        let url = relative_url.map(|value| {
            if value.starts_with("http") {
                value.to_string()
            } else {
                format!("https://tradingeconomics.com{value}")
            }
        });
        let id = row
            .value()
            .attr("data-id")
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}-{}", utc.timestamp(), title.to_lowercase().replace(' ', "-")));

        events.push(EconomicEvent {
            id,
            occurs_at: utc.to_rfc3339(),
            title,
            reference,
            importance: importance_from_cell(cells[0]),
            actual: optional_text(cells[3], &actual_selector),
            previous: optional_text(cells[4], &previous_selector),
            consensus: optional_text(cells[5], &consensus_selector),
            forecast: optional_text(cells[6], &forecast_selector),
            url,
        });
    }

    seen_dates.sort_unstable();
    seen_dates.dedup();
    let covered = seen_dates
        .first()
        .zip(seen_dates.last())
        .is_some_and(|(first, last)| requested >= *first && requested <= *last);
    if !covered {
        return Err(AppError::Api(
            "Trading Economics did not return the requested calendar date".into(),
        ));
    }
    events.sort_by(|left, right| left.occurs_at.cmp(&right.occurs_at).then(left.id.cmp(&right.id)));
    Ok(events)
}

pub fn upcoming_holidays(requested_date: &str) -> Result<Vec<MarketHoliday>, AppError> {
    NaiveDate::parse_from_str(requested_date, "%Y-%m-%d")
        .map_err(|_| AppError::Validation("Trading Today date must use YYYY-MM-DD".into()))?;
    let mut grouped: BTreeMap<&str, MarketHoliday> = BTreeMap::new();
    for entry in HOLIDAYS.iter().filter(|entry| entry.date >= requested_date) {
        let holiday = grouped.entry(entry.date).or_insert_with(|| MarketHoliday {
            date: entry.date.to_string(),
            name: entry.name.to_string(),
            venues: Vec::new(),
        });
        holiday.venues.push(MarketHolidayVenueStatus {
            venue: entry.venue.to_string(),
            status: entry.status.to_string(),
            detail: entry.detail.to_string(),
            source_url: entry.source_url.to_string(),
        });
    }
    Ok(grouped
        .into_values()
        .take(4)
        .map(|mut holiday| {
            holiday.venues.sort_by_key(|venue| if venue.venue == "NYSE" { 0 } else { 1 });
            holiday
        })
        .collect())
}

pub fn get_cache(path: &Path, date: &str) -> Result<Option<TradingTodaySnapshot>, AppError> {
    let Some(value) = storage::load_json_setting(path, CACHE_KEY)? else {
        return Ok(None);
    };
    let mut snapshot: TradingTodaySnapshot = serde_json::from_value(value)?;
    if snapshot.date != date {
        return Ok(None);
    }
    snapshot.status = "cache".into();
    Ok(Some(snapshot))
}

pub async fn refresh(path: &Path, date: &str) -> Result<TradingTodaySnapshot, AppError> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| AppError::Validation("Trading Today date must use YYYY-MM-DD".into()))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("NorthstarTrader/0.1 (+private desktop calendar)")
        .build()?;
    let response = client.get(CALENDAR_URL).send().await?.error_for_status()?;
    let html = response.text().await?;
    let snapshot = TradingTodaySnapshot {
        date: date.to_string(),
        timezone: "America/New_York".into(),
        fetched_at: Utc::now().to_rfc3339(),
        status: "live".into(),
        events: parse_calendar(&html, date)?,
        holidays: upcoming_holidays(date)?,
        source_url: CALENDAR_URL.into(),
        holiday_verified_through: HOLIDAY_VERIFIED_THROUGH.into(),
    };
    storage::save_json_setting(path, CACHE_KEY, &serde_json::to_value(&snapshot)?)?;
    Ok(snapshot)
}

pub fn source_url(source: &str) -> Result<&'static str, AppError> {
    match source {
        "calendar" => Ok(CALENDAR_URL),
        "nyse" => Ok(NYSE_URL),
        "cme" => Ok(CME_URL),
        _ => Err(AppError::Validation("Unknown Trading Today source".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_extracts_fields_and_converts_utc_across_new_york_midnight() {
        let events = parse_calendar(
            include_str!("../fixtures/trading_economics_calendar.html"),
            "2026-07-24",
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].title, "Manufacturing PMI Flash");
        assert_eq!(events[0].importance, Some(3));
        assert_eq!(events[0].actual.as_deref(), Some("53.8"));
        assert_eq!(events[0].previous.as_deref(), Some("53.9"));
        assert_eq!(events[0].consensus.as_deref(), Some("54.3"));
        assert_eq!(events[0].forecast.as_deref(), Some("54.2"));
        assert_eq!(events[1].occurs_at, "2026-07-25T00:30:00+00:00");
        assert_eq!(events[1].importance, None);
    }

    #[test]
    fn valid_covered_day_can_have_no_events() {
        let html = r#"<table id="calendar">
          <tr data-country="united states" data-id="before"><td class="2026-07-23"><span>12:00 PM</span></td><td>US</td><td>Before</td><td></td><td></td><td></td><td></td></tr>
          <tr data-country="united states" data-id="after"><td class="2026-07-25"><span>12:00 PM</span></td><td>US</td><td>After</td><td></td><td></td><td></td><td></td></tr>
        </table>"#;
        let events = parse_calendar(html, "2026-07-24").unwrap();
        assert!(events.is_empty());
    }

    #[test]
    fn changed_markup_is_rejected() {
        let error = parse_calendar("<html><body>no calendar</body></html>", "2026-07-24")
            .unwrap_err()
            .to_string();
        assert!(error.contains("markup was not recognized"));
    }

    #[test]
    fn holidays_merge_venues_and_limit_distinct_dates() {
        let holidays = upcoming_holidays("2026-07-24").unwrap();
        assert_eq!(holidays.len(), 4);
        assert_eq!(holidays[0].date, "2026-09-07");
        assert_eq!(holidays[0].venues.len(), 2);
        assert_eq!(holidays[2].venues[0].status, "early-close");
        assert_eq!(holidays[2].venues[1].status, "modified-hours");
    }

    #[test]
    fn cache_is_scoped_to_the_requested_day() {
        let path = std::env::temp_dir().join(format!(
            "northstar-trading-today-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let snapshot = TradingTodaySnapshot {
            date: "2026-07-24".into(),
            timezone: "America/New_York".into(),
            fetched_at: "2026-07-24T12:00:00Z".into(),
            status: "live".into(),
            events: Vec::new(),
            holidays: Vec::new(),
            source_url: CALENDAR_URL.into(),
            holiday_verified_through: HOLIDAY_VERIFIED_THROUGH.into(),
        };
        storage::save_json_setting(&path, CACHE_KEY, &serde_json::to_value(snapshot).unwrap()).unwrap();
        assert_eq!(get_cache(&path, "2026-07-24").unwrap().unwrap().status, "cache");
        assert!(get_cache(&path, "2026-07-25").unwrap().is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn source_allowlist_rejects_arbitrary_targets() {
        assert_eq!(source_url("calendar").unwrap(), CALENDAR_URL);
        assert!(source_url("https://example.com").is_err());
    }
}
