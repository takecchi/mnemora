-- 公開済みの版 v1.0.2 で作った DB の fixture（ADR 0344）。
-- ⛔ 手で編集しない。作り直すときは scripts/generate-upgrade-fixture.mjs を走らせる。
--
-- 作ったコード: v1.0.2（b981ecdde68e8821f3a823aef2771b414ad89374）の @mnemora/postgres / @mnemora/core / @mnemora/testkit。
-- 埋め込み: @mnemora/testkit の DeterministicEmbeddingProvider（外部 API は使っていない）。
-- 中身: すべて合成データ（秘密・個人情報を含まない）。何を入れたかは
--       scripts/generate-upgrade-fixture.mjs の冒頭を見ること。
--
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11 (Debian 17.11-0+deb13u1)
-- Dumped by pg_dump version 17.11 (Debian 17.11-0+deb13u1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gin; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;


--
-- Name: EXTENSION btree_gin; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gin IS 'support for indexing common datatypes in GIN';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: mnemora_lexical_coverage(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_coverage(content text, query text) RETURNS double precision
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT count(*) FILTER (
           WHERE to_tsvector('simple', mnemora_lexical_normalize(content)) @@ tq
         )::float8 / NULLIF(count(*), 0)
  FROM unnest(mnemora_lexical_query_tsqueries(query)) AS tq;
$$;


--
-- Name: mnemora_lexical_normalize(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_normalize(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT regexp_replace($1, '([[:ascii:]]+)', ' \1 ', 'g');
$_$;


--
-- Name: mnemora_lexical_query_or(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_query_or(text) RETURNS tsquery
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT coalesce(
    (SELECT string_agg('(' || q::text || ')', ' | ')
       FROM unnest(mnemora_lexical_query_tsqueries($1)) AS q)::tsquery,
    ''::tsquery);
$_$;


--
-- Name: mnemora_lexical_query_terms(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_query_terms(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT regexp_replace($1, '[^[:ascii:]]+', ' ', 'g');
$_$;


--
-- Name: mnemora_lexical_query_tsqueries(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_query_tsqueries(text) RETURNS tsquery[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT coalesce(array_agg(DISTINCT q), ARRAY[]::tsquery[])
  FROM (
    SELECT websearch_to_tsquery('simple', '"' || replace(t, '"', '') || '"') AS q
    FROM unnest(regexp_split_to_array(btrim(mnemora_lexical_query_terms($1)), '\s+')) AS t
    WHERE t <> ''
  ) s
  WHERE q::text <> '';
$_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _mnemora_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._mnemora_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.labels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    proposed_count integer DEFAULT 0 NOT NULL,
    registered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT labels_status_check CHECK ((status = ANY (ARRAY['registered'::text, 'proposed'::text])))
);


--
-- Name: memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    subject_id text,
    source_observation_id uuid,
    extractor_version text,
    content text NOT NULL,
    content_hash text NOT NULL,
    digest text NOT NULL,
    digest_source text DEFAULT 'llm'::text NOT NULL,
    provenance_kind text NOT NULL,
    provenance jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    superseded_by_id uuid,
    contested_with_id uuid,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    occurred_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    last_reinforced_at timestamp with time zone,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    strength real DEFAULT 1.0 NOT NULL,
    half_life_hours real NOT NULL,
    decay_floor_at timestamp with time zone NOT NULL,
    embedding_status text DEFAULT 'pending'::text NOT NULL,
    purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    decay_base_seq bigint,
    decay_floor_seq bigint,
    half_life_recalls real,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    claim_key_subject text,
    claim_key_predicate text,
    CONSTRAINT memories_check CHECK (((provenance_kind <> ALL (ARRAY['stated'::text, 'inferred'::text])) OR (source_observation_id IS NOT NULL))),
    CONSTRAINT memories_decay_seq_non_negative CHECK ((((decay_base_seq IS NULL) OR (decay_base_seq >= 0)) AND ((decay_floor_seq IS NULL) OR (decay_floor_seq >= 0)))),
    CONSTRAINT memories_digest_source_check CHECK ((digest_source = ANY (ARRAY['llm'::text, 'fallback'::text]))),
    CONSTRAINT memories_embedding_status_check CHECK ((embedding_status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT memories_half_life_range CHECK (((half_life_hours > (0)::double precision) AND (half_life_hours < 'Infinity'::real))),
    CONSTRAINT memories_half_life_recalls_range CHECK (((half_life_recalls IS NULL) OR ((half_life_recalls > (0)::double precision) AND (half_life_recalls < 'Infinity'::real)))),
    CONSTRAINT memories_provenance_kind_check CHECK ((provenance_kind = ANY (ARRAY['stated'::text, 'inferred'::text, 'consolidated'::text, 'reflected'::text, 'imported'::text]))),
    CONSTRAINT memories_provenance_kind_matches_provenance CHECK ((provenance_kind = (provenance ->> 'kind'::text))),
    CONSTRAINT memories_status_check CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text, 'contested'::text, 'archived'::text, 'forgotten'::text]))),
    CONSTRAINT memories_strength_range CHECK (((strength > (0)::double precision) AND (strength <= (1)::double precision)))
);


--
-- Name: memory_embeddings_test_fixture_model_3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_embeddings_test_fixture_model_3 (
    tenant_id text NOT NULL,
    memory_id uuid NOT NULL,
    embedding public.vector(3) NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memory_embeddings_testkit_deterministic_8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_embeddings_testkit_deterministic_8 (
    tenant_id text NOT NULL,
    memory_id uuid NOT NULL,
    embedding public.vector(8) NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memory_embeddings_all_spaces; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.memory_embeddings_all_spaces AS
 SELECT memory_embeddings_test_fixture_model_3.tenant_id,
    memory_embeddings_test_fixture_model_3.memory_id,
    (memory_embeddings_test_fixture_model_3.embedding)::text AS embedding_text
   FROM public.memory_embeddings_test_fixture_model_3
UNION ALL
 SELECT memory_embeddings_testkit_deterministic_8.tenant_id,
    memory_embeddings_testkit_deterministic_8.memory_id,
    (memory_embeddings_testkit_deterministic_8.embedding)::text AS embedding_text
   FROM public.memory_embeddings_testkit_deterministic_8;


--
-- Name: memory_embeddings_small_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.memory_embeddings_small_view AS
 SELECT tenant_id,
    memory_id,
    embedding,
    model,
    created_at
   FROM public.memory_embeddings_test_fixture_model_3;


--
-- Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 (
    tenant_id text NOT NULL,
    memory_id uuid NOT NULL,
    embedding public.vector(4) NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memory_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    memory_id uuid,
    kind text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    actor jsonb NOT NULL,
    digest_snapshot text,
    size_before_bytes integer,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT memory_events_check CHECK (((kind <> 'events_purged'::text) OR (memory_id IS NULL))),
    CONSTRAINT memory_events_kind_check CHECK ((kind = ANY (ARRAY['created'::text, 'updated'::text, 'superseded'::text, 'archived'::text, 'forgotten'::text, 'purged'::text, 'events_purged'::text, 'restored'::text, 'unsuperseded'::text])))
);


--
-- Name: memory_labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_labels (
    tenant_id text NOT NULL,
    memory_id uuid NOT NULL,
    label_id uuid NOT NULL
);


--
-- Name: observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    subject_id text,
    external_id text,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    claimed_by text,
    attempts integer DEFAULT 0 NOT NULL,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recall_usages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recall_usages (
    tenant_id text NOT NULL,
    recall_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recalls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recalls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    subject_id text,
    query jsonb NOT NULL,
    budget jsonb,
    omitted jsonb DEFAULT '[]'::jsonb NOT NULL,
    usage jsonb NOT NULL,
    index_band jsonb NOT NULL,
    explain jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    returned_memories jsonb NOT NULL
);


--
-- Name: tenant_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_activity (
    tenant_id text NOT NULL,
    activity_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_activity_seq_non_negative CHECK ((activity_seq >= 0))
);


--
-- Name: tenant_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_settings (
    tenant_id text NOT NULL,
    default_half_life_hours real DEFAULT 720 NOT NULL,
    event_retention_days integer,
    taxonomy_mode text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    decay_clock text DEFAULT 'wall'::text NOT NULL,
    default_half_life_recalls real DEFAULT 720 NOT NULL,
    CONSTRAINT tenant_settings_decay_clock_check CHECK ((decay_clock = ANY (ARRAY['wall'::text, 'activity'::text, 'either'::text]))),
    CONSTRAINT tenant_settings_default_half_life_range CHECK (((default_half_life_hours > (0)::double precision) AND (default_half_life_hours < 'Infinity'::real))),
    CONSTRAINT tenant_settings_default_half_life_recalls_range CHECK (((default_half_life_recalls > (0)::double precision) AND (default_half_life_recalls < 'Infinity'::real))),
    CONSTRAINT tenant_settings_taxonomy_mode_check CHECK ((taxonomy_mode = ANY (ARRAY['open'::text, 'strict'::text])))
);


--
-- Data for Name: _mnemora_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public._mnemora_migrations VALUES ('0001_init.sql', '2026-09-27 17:26:35.456023+09');
INSERT INTO public._mnemora_migrations VALUES ('0002_outbox_claim_lease_index.sql', '2026-09-27 17:26:35.478946+09');
INSERT INTO public._mnemora_migrations VALUES ('0003_period_ann_stage_index.sql', '2026-09-27 17:26:35.482169+09');
INSERT INTO public._mnemora_migrations VALUES ('0004_contested_with_index.sql', '2026-09-27 17:26:35.486231+09');
INSERT INTO public._mnemora_migrations VALUES ('0005_analyze_memories.sql', '2026-09-27 17:26:35.489431+09');
INSERT INTO public._mnemora_migrations VALUES ('0006_strength_value_range.sql', '2026-09-27 17:26:35.493148+09');
INSERT INTO public._mnemora_migrations VALUES ('0007_memories_requeue_embed_index.sql', '2026-09-27 17:26:35.496562+09');
INSERT INTO public._mnemora_migrations VALUES ('0008_memories_lexical_index.sql', '2026-09-27 17:26:35.500096+09');
INSERT INTO public._mnemora_migrations VALUES ('0009_memories_lexical_or_coverage.sql', '2026-09-27 17:26:35.50414+09');
INSERT INTO public._mnemora_migrations VALUES ('0010_memory_events_retention_index.sql', '2026-09-27 17:26:35.507506+09');
INSERT INTO public._mnemora_migrations VALUES ('0011_memory_events_kind_restored.sql', '2026-09-27 17:26:35.510072+09');
INSERT INTO public._mnemora_migrations VALUES ('0012_half_life_hours_range.sql', '2026-09-27 17:26:35.515188+09');
INSERT INTO public._mnemora_migrations VALUES ('0013_recall_returned_memories_jsonb.sql', '2026-09-27 17:26:35.517753+09');
INSERT INTO public._mnemora_migrations VALUES ('0014_observations_valid_from_until.sql', '2026-09-27 17:26:35.520787+09');
INSERT INTO public._mnemora_migrations VALUES ('0015_decay_activity_clock.sql', '2026-09-27 17:26:35.523258+09');
INSERT INTO public._mnemora_migrations VALUES ('0016_provenance_kind_matches_provenance.sql', '2026-09-27 17:26:35.530094+09');
INSERT INTO public._mnemora_migrations VALUES ('0017_provenance_kind_matches_provenance_validate.sql', '2026-09-27 17:26:35.533115+09');
INSERT INTO public._mnemora_migrations VALUES ('0018_memory_events_kind_unsuperseded.sql', '2026-09-27 17:26:35.535981+09');
INSERT INTO public._mnemora_migrations VALUES ('0019_observations_memories_attributes.sql', '2026-09-27 17:26:35.541024+09');
INSERT INTO public._mnemora_migrations VALUES ('0020_taxonomy_labels.sql', '2026-09-27 17:26:35.545873+09');
INSERT INTO public._mnemora_migrations VALUES ('0021_memories_claim_key.sql', '2026-09-27 17:26:35.558289+09');
INSERT INTO public._mnemora_migrations VALUES ('0022_embedding_zero_norm_index.sql', '2026-09-27 17:26:35.561986+09');


--
-- Data for Name: labels; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: memories; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memories VALUES ('315c766c-88ec-4aec-879e-46becac0e106', 'tenant-a', NULL, '60a81646-0fb0-4f1b-9bef-784b5ebd0a2f', 'v1', 'tenant-a の記憶 1 東京 会議 プロジェクト1', 'ed6b6174b16e829904eb19e37af61bcdac066ad24d037aab65ab91746f903e4e', 'tenant-a の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.635Z", "kind": "stated", "speaker": "user", "sourceObservationId": "60a81646-0fb0-4f1b-9bef-784b5ebd0a2f"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.639+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.26+09', 'ready', NULL, '2026-09-27 17:26:35.640443+09', '2026-09-27 17:26:35.913225+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('37bcb397-24bd-48ac-a58b-dcef8f8b7661', 'tenant-a', NULL, 'b92b183b-08e8-477a-b845-9ca850327687', 'v1', 'tenant-a の記憶 2 東京 会議 プロジェクト2', 'd5783633ec67bfa023b1656bde0eda60589e932b2e5eb00bad51d9366c647db5', 'tenant-a の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.646Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b92b183b-08e8-477a-b845-9ca850327687"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.649+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.27+09', 'ready', NULL, '2026-09-27 17:26:35.650371+09', '2026-09-27 17:26:35.920842+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('937a0ddb-31e4-400c-bb04-602644bf0f29', 'tenant-a', NULL, 'a8da4ac0-abdb-4e3f-8877-197c43773745', 'v1', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', 'd6d0bf800f00f3c35af37625f3533767a4db7afbdc77fe18c3bc2d5987ba70c1', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.655Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a8da4ac0-abdb-4e3f-8877-197c43773745"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.659+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.28+09', 'ready', NULL, '2026-09-27 17:26:35.661257+09', '2026-09-27 17:26:35.928053+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f84da5fa-5216-4cac-9f7f-f1416c88669a', 'tenant-a', NULL, 'e1d0b3b9-06b8-447f-9faa-4df5a0ecfdb3', 'v1', 'tenant-a の記憶 5 東京 会議 プロジェクト0', 'edf34c29245092db70ab98057250239de4f569a113efa424ebda0f9cd882bd55', 'tenant-a の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.681Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e1d0b3b9-06b8-447f-9faa-4df5a0ecfdb3"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.689+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.31+09', 'ready', NULL, '2026-09-27 17:26:35.690017+09', '2026-09-27 17:26:35.943403+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c0018122-60ce-4424-ad53-8f60715b9cbd', 'tenant-a', NULL, 'e58095dd-c384-49a7-9922-bb2858bc6036', 'v1', 'tenant-a の記憶 7 東京 会議 プロジェクト2', '0c60f6ec18ba3a28b875b6830e0201a28a0ce0a0831c5c1cfa14d9213f4fccc3', 'tenant-a の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.705Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e58095dd-c384-49a7-9922-bb2858bc6036"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.708+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.329+09', 'ready', NULL, '2026-09-27 17:26:35.709697+09', '2026-09-27 17:26:35.958702+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('328cd828-8369-4e71-9b7c-be834684f172', 'tenant-a', NULL, '64260722-19c0-47ae-83b6-8f7864699f71', 'v1', 'tenant-a の記憶 12 東京 会議 プロジェクト2', '1416843979dca4b10e813c98b42e4e64184da19a8246431ca987465bf0319a69', 'tenant-a の記憶 12 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.767Z", "kind": "stated", "speaker": "user", "sourceObservationId": "64260722-19c0-47ae-83b6-8f7864699f71"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.771+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.392+09', 'ready', NULL, '2026-09-27 17:26:35.772377+09', '2026-09-27 17:26:35.991113+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('fd0091ab-fb3e-47ae-abdb-721f489eaa2c', 'tenant-a', NULL, 'ab01e3cc-86ea-4ca4-a23f-a8cfea8e45f9', 'v1', 'tenant-a の記憶 13 東京 会議 プロジェクト3', '85fa57655dee036fb504dc9e026f2dfe383c1140f5fab5d93ff65f97a76f63c1', 'tenant-a の記憶 13 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.779Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ab01e3cc-86ea-4ca4-a23f-a8cfea8e45f9"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.782+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.403+09', 'ready', NULL, '2026-09-27 17:26:35.783325+09', '2026-09-27 17:26:35.997172+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('320440dd-9312-45b2-9d54-40f967e9284d', 'tenant-a', NULL, '52e62322-c06d-4689-94af-2e3e11534711', 'v1', 'tenant-a の記憶 14 東京 会議 プロジェクト4', '566c00e514039c3cbdde42ca12af98244b4fc1d1fba5c31799c41667ccb84955', 'tenant-a の記憶 14 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.789Z", "kind": "stated", "speaker": "user", "sourceObservationId": "52e62322-c06d-4689-94af-2e3e11534711"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.792+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.413+09', 'ready', NULL, '2026-09-27 17:26:35.792804+09', '2026-09-27 17:26:36.003995+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('18e03139-30b2-4af2-b2e6-0d716498ab9c', 'tenant-a', NULL, '60e3a87d-f8d0-43bd-989d-489387db8b9d', 'v1', 'tenant-a の記憶 15 東京 会議 プロジェクト0', 'f0b29bf3fc257d56d53bf3a40509a30894afa7846eb7397ab547ea18a3a29c38', 'tenant-a の記憶 15 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.797Z", "kind": "stated", "speaker": "user", "sourceObservationId": "60e3a87d-f8d0-43bd-989d-489387db8b9d"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.8+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.421+09', 'ready', NULL, '2026-09-27 17:26:35.80112+09', '2026-09-27 17:26:36.010783+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('fbd2137c-6d45-4ae6-a861-6063be83dfca', 'tenant-a', NULL, '6d10b834-cca1-4aa1-ba31-91e2c490bc09', 'v1', 'tenant-a の記憶 4 東京 会議 プロジェクト4', '2d4011873ef8b25d39bde2a8122f185e9e032a938e8e1020e527a073b0930df3', 'tenant-a の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.668Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6d10b834-cca1-4aa1-ba31-91e2c490bc09"}', 'superseded', 'f84da5fa-5216-4cac-9f7f-f1416c88669a', NULL, '{}', NULL, '2026-09-27 17:26:35.673+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.294+09', 'ready', NULL, '2026-09-27 17:26:35.674321+09', '2026-09-27 17:26:36.113332+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('531faf45-6027-4cb6-ae98-ad649a330750', 'tenant-a', NULL, 'f753521f-2e25-4cb5-85cd-ff074011b5a6', 'v1', 'tenant-a の記憶 6 東京 会議 プロジェクト1', 'd930b5a8cf81e3b3b32791e8dae3c05994da72ef1265c035dfaf39080ed62dbe', 'tenant-a の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.696Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f753521f-2e25-4cb5-85cd-ff074011b5a6"}', 'contested', NULL, 'd51c9734-c69a-4b73-8477-1ebfdf639af2', '{}', NULL, '2026-09-27 17:26:35.699+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.32+09', 'ready', NULL, '2026-09-27 17:26:35.700454+09', '2026-09-27 17:26:36.117234+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ab6b5ced-2f58-441a-b246-080f679e716f', 'tenant-a', NULL, '52d2cafd-4636-4094-a8a8-47f69ed72d55', 'v1', 'tenant-a の記憶 9 東京 会議 プロジェクト4', '4c241e9f2abb28b016af405d09bb673284fc201c4fac4a039faba6f8c7e22fc3', 'tenant-a の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.733Z", "kind": "stated", "speaker": "user", "sourceObservationId": "52d2cafd-4636-4094-a8a8-47f69ed72d55"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.737+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.358+09', 'ready', NULL, '2026-09-27 17:26:35.738763+09', '2026-09-27 17:26:36.123775+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d9a771ce-7838-4aa3-bb79-68258516cf55', 'tenant-a', NULL, '8f4ba517-90c3-456f-8c87-02527eb7bcd8', 'v1', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', 'f43c8e3670dc49dcd5e7d3d4067e6675ad27bf370e403c97f646b08db859894f', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.745Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8f4ba517-90c3-456f-8c87-02527eb7bcd8"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.749+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.37+09', 'ready', NULL, '2026-09-27 17:26:35.750082+09', '2026-09-27 17:26:36.126827+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('3273cf62-0261-4c39-89d7-a561df70af7d', 'tenant-a', NULL, 'de7961a2-4764-4e1f-914f-62ebe80a5a52', 'v1', '[purged]', '8baacaa745d740261839f6dbe908954009bba75aead9ea0901933a52379e09f4', '[purged]', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.756Z", "kind": "stated", "speaker": "user", "sourceObservationId": "de7961a2-4764-4e1f-914f-62ebe80a5a52"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.76+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.381+09', 'ready', '2026-09-27 17:26:36.134989+09', '2026-09-27 17:26:35.761265+09', '2026-09-27 17:26:36.134989+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('603bd1d7-ad6e-4be4-950e-26058d1e381a', 'tenant-a', NULL, '2ec4c136-c6c9-45cb-b0bf-815c579352c9', 'v1', 'tenant-a の記憶 0 東京 会議 プロジェクト0', 'd3ea19d3736314cb9c467c1662164327f232b7f4614ea76f675772f69c277594', 'tenant-a の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.604Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2ec4c136-c6c9-45cb-b0bf-815c579352c9"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.619+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.24+09', 'ready', NULL, '2026-09-27 17:26:35.621636+09', '2026-09-27 17:26:35.903793+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c7cc1eab-71b0-4171-b1cd-dd2e45f437b3', 'tenant-a', NULL, 'caa8c67d-a62c-40ab-9561-780b9c7a7040', 'v1', 'tenant-a の記憶 16 東京 会議 プロジェクト1', 'ca52ff79646f23e88b31f2cd9bab84db866daa8ee904c6ffc4f2608348e05082', 'tenant-a の記憶 16 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.806Z", "kind": "stated", "speaker": "user", "sourceObservationId": "caa8c67d-a62c-40ab-9561-780b9c7a7040"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.808+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.429+09', 'ready', NULL, '2026-09-27 17:26:35.809619+09', '2026-09-27 17:26:36.017356+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('83d44a87-2717-4941-9dca-cb04401c0f3a', 'tenant-a', NULL, '06cd2f83-edae-4ee8-b060-936a6a5e0ab2', 'v1', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', 'b143762528afffbb72a33fb24f70ebd4d19cd0cc89719dd7231a45971896fde7', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.815Z", "kind": "stated", "speaker": "user", "sourceObservationId": "06cd2f83-edae-4ee8-b060-936a6a5e0ab2"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.818+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.439+09', 'ready', NULL, '2026-09-27 17:26:35.818861+09', '2026-09-27 17:26:36.025716+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('891e6d25-c61b-4e89-ab22-3cbb648d5bbb', 'tenant-a', NULL, '7296c24f-a6b2-4c78-b5a3-76570891d8bc', 'v1', 'tenant-a の記憶 18 東京 会議 プロジェクト3', '6d3a158a624537a869f95ca05e650119d80bbe0cd4f796b22bc3c31ea83ada8a', 'tenant-a の記憶 18 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.824Z", "kind": "stated", "speaker": "user", "sourceObservationId": "7296c24f-a6b2-4c78-b5a3-76570891d8bc"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.826+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.447+09', 'ready', NULL, '2026-09-27 17:26:35.827349+09', '2026-09-27 17:26:36.034252+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('73c39b8f-033e-490a-89e4-e8462dd18fc8', 'tenant-a', NULL, '53126ad7-d2e6-4c07-8aae-a427b9622807', 'v1', 'tenant-a の記憶 19 東京 会議 プロジェクト4', '83b96ac18e746f06f8c77902fd8d7e7f3c59541caaa6ae2658298580ec04e043', 'tenant-a の記憶 19 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.833Z", "kind": "stated", "speaker": "user", "sourceObservationId": "53126ad7-d2e6-4c07-8aae-a427b9622807"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.836+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.457+09', 'ready', NULL, '2026-09-27 17:26:35.837089+09', '2026-09-27 17:26:36.041497+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b43cb04f-a124-4399-ba56-13035c654ac1', 'tenant-a', NULL, '4ec8a0a8-7706-4607-b872-61ccd8587309', 'v1', 'tenant-a の記憶 21 東京 会議 プロジェクト1', '4c3e66f819f467c96c28794801e751d2d4f6a9e3cd240dcfc9c3bf55c1cacc57', 'tenant-a の記憶 21 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.851Z", "kind": "stated", "speaker": "user", "sourceObservationId": "4ec8a0a8-7706-4607-b872-61ccd8587309"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.854+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.475+09', 'ready', NULL, '2026-09-27 17:26:35.85476+09', '2026-09-27 17:26:36.058164+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c9cc58ac-32b7-4891-b5c0-8025884d8703', 'tenant-a', NULL, '5e3a9113-7f50-426a-8313-8fae3d5ef17f', 'v1', 'tenant-a の記憶 22 東京 会議 プロジェクト2', 'b72c9757075adda4486522b26365dfd82a6af69336a4c8f52d4771450c4ce0af', 'tenant-a の記憶 22 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.859Z", "kind": "stated", "speaker": "user", "sourceObservationId": "5e3a9113-7f50-426a-8313-8fae3d5ef17f"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.862+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.483+09', 'ready', NULL, '2026-09-27 17:26:35.862926+09', '2026-09-27 17:26:36.064368+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a969f669-00e9-4797-9f48-34a1a6fc16b6', 'tenant-a', NULL, '874422f5-8811-47f0-bfa8-0c01c09cde5a', 'v1', 'tenant-a の記憶 23 東京 会議 プロジェクト3', '26d0049fe3cf7614c786a48dd795226413a4f6260e020ea8356d457c6ff1ca3f', 'tenant-a の記憶 23 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.869Z", "kind": "stated", "speaker": "user", "sourceObservationId": "874422f5-8811-47f0-bfa8-0c01c09cde5a"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.873+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.494+09', 'ready', NULL, '2026-09-27 17:26:35.874196+09', '2026-09-27 17:26:36.071285+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1990b7cf-4b34-4127-bc05-2b57ca8e6204', 'tenant-a', NULL, 'ba566891-f636-4941-b313-af224382542f', 'v1', 'tenant-a FAIL 埋め込み失敗 東京', 'ab1702dac85d2545c823794fc8106c348a2783463f2ac321911b7721adc9a696', 'tenant-a FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.882Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ba566891-f636-4941-b313-af224382542f"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.885+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.506+09', 'failed', NULL, '2026-09-27 17:26:35.886549+09', '2026-09-27 17:26:36.077289+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('eb4c800b-4fcb-4ab7-9010-0c5becf8a23c', 'tenant-a', NULL, '919b4f30-5a2b-4c09-a804-047a26f343bf', 'v1', 'tenant-a 未埋め込み 0', '756d0ee3ef05fe980db2aa5224ed49ab257c9c10a80d33a77df32294e4a9b497', 'tenant-a 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.081Z", "kind": "stated", "speaker": "user", "sourceObservationId": "919b4f30-5a2b-4c09-a804-047a26f343bf"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.084+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.705+09', 'pending', NULL, '2026-09-27 17:26:36.085105+09', '2026-09-27 17:26:36.085105+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('11fbbb9d-e670-4358-a572-e39af12247ba', 'tenant-a', NULL, 'e466180c-70dc-4acc-9be0-6059048db745', 'v1', 'tenant-a 未埋め込み 1', '7a1a046d3656ac2ae59f0f95d457c9c60be31eb915f2dd5cdc53822faaefdf48', 'tenant-a 未埋め込み 1', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.091Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e466180c-70dc-4acc-9be0-6059048db745"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.094+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.715+09', 'pending', NULL, '2026-09-27 17:26:36.095401+09', '2026-09-27 17:26:36.095401+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8fc143fc-d18b-4d3c-9dbf-592f5bdf9d93', 'tenant-a', NULL, 'a53c5203-b4e5-4ca6-9f75-418681c84dbd', 'v1', 'tenant-a 未埋め込み 2', '899e3558b907c6a4074d675812af26d32f5a4d665344080e52cfed3d3c1218f6', 'tenant-a 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.100Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a53c5203-b4e5-4ca6-9f75-418681c84dbd"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.104+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.725+09', 'skipped', NULL, '2026-09-27 17:26:36.104947+09', '2026-09-27 17:26:36.110851+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d51c9734-c69a-4b73-8477-1ebfdf639af2', 'tenant-a', NULL, '607f39d7-2edf-42cf-88c9-10d420f0aa5f', 'v1', 'tenant-a の記憶 8 東京 会議 プロジェクト3', 'b80d062281da38b404565ed86841de51799a3a0b5a8332e8ae6c080d35716009', 'tenant-a の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.716Z", "kind": "stated", "speaker": "user", "sourceObservationId": "607f39d7-2edf-42cf-88c9-10d420f0aa5f"}', 'contested', NULL, '531faf45-6027-4cb6-ae98-ad649a330750', '{}', NULL, '2026-09-27 17:26:35.724+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.345+09', 'ready', NULL, '2026-09-27 17:26:35.725622+09', '2026-09-27 17:26:36.117234+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6a49af7d-5d1b-4ef4-a1f8-464a557668c0', 'tenant-a', NULL, 'bd4375d3-d750-4edf-8a1d-e1ce96176ae4', 'v1', 'tenant-a の記憶 20 東京 会議 プロジェクト0', '30b8312facf5b4d080051518335646cf1b0811d3dd74936bb276b5f511c2fda4', 'tenant-a の記憶 20 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-27T08:26:35.842Z", "kind": "stated", "speaker": "user", "sourceObservationId": "bd4375d3-d750-4edf-8a1d-e1ce96176ae4"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:35.845+09', '2026-09-27 17:26:36.178+09', NULL, NULL, 1, 720, '2027-02-04 09:13:53.799+09', 'ready', NULL, '2026-09-27 17:26:35.84656+09', '2026-09-27 17:26:36.179787+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f387983a-c837-441e-959b-c23f20ad8d66', 'tenant-b', NULL, 'e48c0eeb-cc22-4516-a583-310f20b6e182', 'v1', 'tenant-b の記憶 1 東京 会議 プロジェクト1', 'b95da75a3bc21f8d9d823c4d001c8086e008dcc6b38e31d6ed7199e9b758b564', 'tenant-b の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.219Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e48c0eeb-cc22-4516-a583-310f20b6e182"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.222+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.843+09', 'ready', NULL, '2026-09-27 17:26:36.223418+09', '2026-09-27 17:26:36.393112+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c3da3459-3ec9-4f3f-9888-fe229dca53ff', 'tenant-b', NULL, '1f83e39e-d6ec-458b-b505-461efa599f7f', 'v1', 'tenant-b の記憶 2 東京 会議 プロジェクト2', 'fef0437ad217559ad5fb73795ca3cec2b335060d36ad7ba7a9da30c623a8f0d3', 'tenant-b の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.227Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1f83e39e-d6ec-458b-b505-461efa599f7f"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.23+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.851+09', 'ready', NULL, '2026-09-27 17:26:36.231497+09', '2026-09-27 17:26:36.398717+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('0f9c4e4e-e032-4b59-bf58-8823843b4e35', 'tenant-b', NULL, 'c390fdb8-ce15-4ab0-8310-9b615e4a3dc9', 'v1', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', '4e273dcb447fab0d9f4acfd5e8288bf45f0c7eb77b08b9cc0534c25d49c0c4f8', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.236Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c390fdb8-ce15-4ab0-8310-9b615e4a3dc9"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.239+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.86+09', 'ready', NULL, '2026-09-27 17:26:36.239839+09', '2026-09-27 17:26:36.405132+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f1160e8a-c2f0-4577-b634-5a6479ffd228', 'tenant-b', NULL, 'd5a1552c-ae89-4403-8823-c2301b71c756', 'v1', 'tenant-b の記憶 5 東京 会議 プロジェクト0', '1d9b410d61390a28c636568bbffd238b4e1012db936d587ca2fb4c25642981e9', 'tenant-b の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.252Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d5a1552c-ae89-4403-8823-c2301b71c756"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.255+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.876+09', 'ready', NULL, '2026-09-27 17:26:36.255893+09', '2026-09-27 17:26:36.414899+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e8702899-a403-49e2-affa-6113c6f4ac50', 'tenant-b', NULL, 'a39f03aa-2a7e-4091-809f-3b358d5d4a37', 'v1', 'tenant-b の記憶 7 東京 会議 プロジェクト2', 'f1d4ed789aa4b33b86f74868c1d9f1efbac874dbb3cbbdd89a13eabcd6826704', 'tenant-b の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.280Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a39f03aa-2a7e-4091-809f-3b358d5d4a37"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.282+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.903+09', 'ready', NULL, '2026-09-27 17:26:36.283525+09', '2026-09-27 17:26:36.423573+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e857ce21-e916-415a-a351-8525f01fa2f2', 'tenant-b', NULL, '8f287c02-9530-43eb-9ea0-2d552da1c655', 'v1', 'tenant-b の記憶 12 東京 会議 プロジェクト2', '7b361a170b64a9b41f97d624b8bc1cb0f2c68950bfea639ccb5a23c4344575f8', 'tenant-b の記憶 12 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.319Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8f287c02-9530-43eb-9ea0-2d552da1c655"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.321+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.942+09', 'ready', NULL, '2026-09-27 17:26:36.322008+09', '2026-09-27 17:26:36.451601+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('06328de7-b40a-4e80-9628-49d3dd977ff5', 'tenant-b', NULL, '7be8c187-6ef0-484a-bd27-145347754c8b', 'v1', 'tenant-b の記憶 13 東京 会議 プロジェクト3', '0dc090582bdaf2135130a122f6f926027aa9346166b076aa7ce9d878071c18f3', 'tenant-b の記憶 13 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.325Z", "kind": "stated", "speaker": "user", "sourceObservationId": "7be8c187-6ef0-484a-bd27-145347754c8b"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.328+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.949+09', 'ready', NULL, '2026-09-27 17:26:36.328773+09', '2026-09-27 17:26:36.457167+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('487c1ffc-1b58-4795-afc0-45d6dafdb200', 'tenant-b', NULL, 'ff7241b1-7fa2-4cd4-9ff8-b319435ecc97', 'v1', 'tenant-b の記憶 15 東京 会議 プロジェクト0', '159e45fbd8a5ffaff4ae601883d4d60fd353ceca26759a1642630065cef3b241', 'tenant-b の記憶 15 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.349Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ff7241b1-7fa2-4cd4-9ff8-b319435ecc97"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.351+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.972+09', 'ready', NULL, '2026-09-27 17:26:36.352321+09', '2026-09-27 17:26:36.469516+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('09092d23-aabc-4d1c-af04-6652a4895738', 'tenant-b', NULL, '09141171-b041-4047-9d5f-fe922042ff56', 'v1', 'tenant-b の記憶 4 東京 会議 プロジェクト4', '5940641d2d369c2cc336a4e7e0dfe324af8bd43c6c6bb540111ea25536b9f590', 'tenant-b の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.244Z", "kind": "stated", "speaker": "user", "sourceObservationId": "09141171-b041-4047-9d5f-fe922042ff56"}', 'superseded', 'f1160e8a-c2f0-4577-b634-5a6479ffd228', NULL, '{}', NULL, '2026-09-27 17:26:36.247+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.868+09', 'ready', NULL, '2026-09-27 17:26:36.247993+09', '2026-09-27 17:26:36.51377+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('29186798-1902-47d4-8c0b-9ff615a52b07', 'tenant-b', NULL, '76328bf5-29fe-4f88-9452-4c3eb3b7c47e', 'v1', 'tenant-b の記憶 6 東京 会議 プロジェクト1', '25dbc01aa826c3caa1c214b61d630f769615fc5a4f74f62be2b71c2a659e3fa8', 'tenant-b の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.271Z", "kind": "stated", "speaker": "user", "sourceObservationId": "76328bf5-29fe-4f88-9452-4c3eb3b7c47e"}', 'contested', NULL, 'e1dfe4d9-6d5a-470d-8a6f-98374b0487a3', '{}', NULL, '2026-09-27 17:26:36.275+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.896+09', 'ready', NULL, '2026-09-27 17:26:36.275814+09', '2026-09-27 17:26:36.51654+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8c3351de-f808-4dc4-98d7-c8185e9ed5fb', 'tenant-b', NULL, '93c40601-7bad-4270-8a6e-2bf49b370ef8', 'v1', 'tenant-b の記憶 9 東京 会議 プロジェクト4', '1e67543f28e3ecb46017a56947f528295cfd849f37bbff911216c8f13f03cb45', 'tenant-b の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.296Z", "kind": "stated", "speaker": "user", "sourceObservationId": "93c40601-7bad-4270-8a6e-2bf49b370ef8"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.299+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.92+09', 'ready', NULL, '2026-09-27 17:26:36.299955+09', '2026-09-27 17:26:36.52156+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('7ce0c761-95d5-449b-832c-f96e8c75e7f8', 'tenant-b', NULL, '34d110e2-5572-4fbc-943f-3af2161e9f34', 'v1', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', 'e3ce75d1b42cf68db24819b6cf5a26b4168b236f492bda9ec4f44f99baf6e59f', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.304Z", "kind": "stated", "speaker": "user", "sourceObservationId": "34d110e2-5572-4fbc-943f-3af2161e9f34"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.307+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.928+09', 'ready', NULL, '2026-09-27 17:26:36.307819+09', '2026-09-27 17:26:36.524245+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('01a3dad3-85e2-4ec4-983b-f89ccb781630', 'tenant-b', NULL, 'b76d551b-d658-4a44-8c0c-f8feb6753277', 'v1', '[purged]', '624794e8e55d99b8d71021f048790ff041d1bfb438372d59bcdfa91e5e3b0bcd', '[purged]', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.312Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b76d551b-d658-4a44-8c0c-f8feb6753277"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.315+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.936+09', 'ready', '2026-09-27 17:26:36.52974+09', '2026-09-27 17:26:36.315734+09', '2026-09-27 17:26:36.52974+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('113c85be-2a5c-4010-bc1d-7ec8474c262b', 'tenant-b', NULL, 'aeff008b-66fa-46d9-8e1f-d50973fa7462', 'v1', 'tenant-b の記憶 14 東京 会議 プロジェクト4', '8a607cfc5964eaf69142f32afe35b75600e27d38176864ada321967ce349bc64', 'tenant-b の記憶 14 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.341Z", "kind": "stated", "speaker": "user", "sourceObservationId": "aeff008b-66fa-46d9-8e1f-d50973fa7462"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.344+09', '2026-09-27 17:26:36.557+09', NULL, NULL, 1, 720, '2027-02-04 09:13:54.178+09', 'ready', NULL, '2026-09-27 17:26:36.344996+09', '2026-09-27 17:26:36.558375+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c5033310-c878-4ba9-8794-43c0f5fb35e5', 'tenant-b', NULL, '8081bf55-caa1-4b69-b5bb-084207cdc5d0', 'v1', 'tenant-b の記憶 0 東京 会議 プロジェクト0', '081a9a9f113b084d0ccebeb4e29f753910bca11b2e4e20168eca50413e85a174', 'tenant-b の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.185Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8081bf55-caa1-4b69-b5bb-084207cdc5d0"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.188+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.809+09', 'ready', NULL, '2026-09-27 17:26:36.188686+09', '2026-09-27 17:26:36.387592+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d1eb71b3-5dfa-4433-b45b-5b50f821a8af', 'tenant-b', NULL, 'fb698135-7690-4c80-9787-87b733e2ffaf', 'v1', 'tenant-b の記憶 16 東京 会議 プロジェクト1', 'b8c54c018860dad1bd5d84c2883f7deef7dba67a41562560b7454f3565547826', 'tenant-b の記憶 16 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.356Z", "kind": "stated", "speaker": "user", "sourceObservationId": "fb698135-7690-4c80-9787-87b733e2ffaf"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.359+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.98+09', 'ready', NULL, '2026-09-27 17:26:36.359952+09', '2026-09-27 17:26:36.476042+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c4fe7115-cb76-4111-8d41-74de41cc1199', 'tenant-b', NULL, 'c2a0fcdf-0879-4b48-a587-12caae591b39', 'v1', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', '512794d1b4203897a59658ba1c10d0d4ff10f5d69627a6dffa186e0a86c02feb', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.365Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c2a0fcdf-0879-4b48-a587-12caae591b39"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.367+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.988+09', 'ready', NULL, '2026-09-27 17:26:36.367919+09', '2026-09-27 17:26:36.481253+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('2c33c03c-2eb8-4608-8c05-1105ae1b6e9e', 'tenant-b', NULL, '16faf11f-699f-4dd9-9c59-b90819d66069', 'v1', 'tenant-b FAIL 埋め込み失敗 東京', 'dca6507a3912ad169580cf2764c29ddf080a9cbf73c32d7ddf16429d985d35ef', 'tenant-b FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.373Z", "kind": "stated", "speaker": "user", "sourceObservationId": "16faf11f-699f-4dd9-9c59-b90819d66069"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.376+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.997+09', 'failed', NULL, '2026-09-27 17:26:36.377576+09', '2026-09-27 17:26:36.485278+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a06b4513-d95f-4536-a116-aa5ce2a02a5d', 'tenant-b', NULL, '1b56eb33-0cf9-4c14-a83b-86b6ead9ddef', 'v1', 'tenant-b 未埋め込み 0', '4f033a8ab5dff18cce4bfac1ffa04151f80b45e51806b9cebeca92a143ae6386', 'tenant-b 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.487Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1b56eb33-0cf9-4c14-a83b-86b6ead9ddef"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.49+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.111+09', 'pending', NULL, '2026-09-27 17:26:36.490842+09', '2026-09-27 17:26:36.490842+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('bc21c13f-dadc-4a44-9a4e-2e86c70ce3ec', 'tenant-b', NULL, 'a307973c-b938-4b8a-873e-54e5b05b5d32', 'v1', 'tenant-b 未埋め込み 1', '9d77f4b53475fe24e31aaa3bcdc02aa1a0786c37888dcee783f146c4aae191e2', 'tenant-b 未埋め込み 1', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.494Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a307973c-b938-4b8a-873e-54e5b05b5d32"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.497+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.118+09', 'pending', NULL, '2026-09-27 17:26:36.498557+09', '2026-09-27 17:26:36.498557+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('3d39dc08-75d2-4d73-8504-2b36abecb7bd', 'tenant-b', NULL, '738de718-2b91-4989-b0b1-e5a2c91b8e11', 'v1', 'tenant-b 未埋め込み 2', '318fb30d6dda58f1c972e4779c59979fbd926637878da937d6155ac62a286d02', 'tenant-b 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.503Z", "kind": "stated", "speaker": "user", "sourceObservationId": "738de718-2b91-4989-b0b1-e5a2c91b8e11"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.504+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.125+09', 'skipped', NULL, '2026-09-27 17:26:36.505061+09', '2026-09-27 17:26:36.510645+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e1dfe4d9-6d5a-470d-8a6f-98374b0487a3', 'tenant-b', NULL, 'bc582561-d81f-4324-8387-7edb335017a4', 'v1', 'tenant-b の記憶 8 東京 会議 プロジェクト3', '03f24fe74d5d2e3d56878e412d3b0daf983f57c46d18f1bf25917b76cf7ef9f6', 'tenant-b の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.288Z", "kind": "stated", "speaker": "user", "sourceObservationId": "bc582561-d81f-4324-8387-7edb335017a4"}', 'forgotten', NULL, '29186798-1902-47d4-8c0b-9ff615a52b07', '{}', NULL, '2026-09-27 17:26:36.29+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:53.911+09', 'ready', NULL, '2026-09-27 17:26:36.291636+09', '2026-09-27 17:26:36.534934+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ce0f3b70-1463-4ba7-aa80-0bebad9188bd', 'tenant-c', NULL, '6513b15b-a19b-461f-b004-4b2f1c8b8236', 'v1', 'tenant-c の記憶 1 東京 会議 プロジェクト1', 'f97a8b4d6e8a9c4b9cc08f892895a26c5150d4dc14b0da37a299e97b759312b2', 'tenant-c の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.571Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6513b15b-a19b-461f-b004-4b2f1c8b8236"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.574+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.195+09', 'ready', NULL, '2026-09-27 17:26:36.575249+09', '2026-09-27 17:26:36.697903+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1e8ced31-96c4-4001-bfb8-83fab2066475', 'tenant-c', NULL, '186851b6-5dab-4208-8a47-74679b18c535', 'v1', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', '94612eb1b4f64fa932a1d3db6feb48231cb950d9ffd00939776db4cf1eb29c26', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.588Z", "kind": "stated", "speaker": "user", "sourceObservationId": "186851b6-5dab-4208-8a47-74679b18c535"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.591+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.212+09', 'ready', NULL, '2026-09-27 17:26:36.59264+09', '2026-09-27 17:26:36.714585+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('7e362988-a627-4473-8a3c-207b893df777', 'tenant-c', NULL, '85ee900e-3a10-4dc9-8589-61b94d7d0646', 'v1', 'tenant-c の記憶 7 東京 会議 プロジェクト2', '8c524a04f68127aef3b7b341e63ac27629ee3136f0ef9da63934e27c206cb419', 'tenant-c の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.626Z", "kind": "stated", "speaker": "user", "sourceObservationId": "85ee900e-3a10-4dc9-8589-61b94d7d0646"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.629+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.25+09', 'ready', NULL, '2026-09-27 17:26:36.630445+09', '2026-09-27 17:26:36.74238+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('17973227-9578-4d24-a11e-ed82b1a18dfe', 'tenant-c', NULL, 'f7b86ca3-c8dd-4685-8073-223c6ba4bdb9', 'v1', 'tenant-c の記憶 4 東京 会議 プロジェクト4', '81f4ee70cb39ef24184d9447f8e119462e2b333831286169f12207dd00f50327', 'tenant-c の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.598Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f7b86ca3-c8dd-4685-8073-223c6ba4bdb9"}', 'superseded', '773290c4-be30-41a2-bee6-97c76e908090', NULL, '{}', NULL, '2026-09-27 17:26:36.601+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.222+09', 'ready', NULL, '2026-09-27 17:26:36.602452+09', '2026-09-27 17:26:36.828892+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('176f8c3f-3d62-4bf3-8809-3632fa31b276', 'tenant-c', NULL, '17aff098-781c-4e5b-923e-47bea2eb80ad', 'v1', 'tenant-c の記憶 6 東京 会議 プロジェクト1', '1349732c0ebd9031ddc9bcae41973c5c6b6ab2f76e2179b5374ad6957af1fe87', 'tenant-c の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.618Z", "kind": "stated", "speaker": "user", "sourceObservationId": "17aff098-781c-4e5b-923e-47bea2eb80ad"}', 'contested', NULL, 'e06636e2-bed7-489d-8e79-0fda31d3e677', '{}', NULL, '2026-09-27 17:26:36.621+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.242+09', 'ready', NULL, '2026-09-27 17:26:36.621953+09', '2026-09-27 17:26:36.831465+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('773290c4-be30-41a2-bee6-97c76e908090', 'tenant-c', NULL, 'dca56308-506e-4890-acdf-80f1c0a56318', 'v1', 'tenant-c の記憶 5 東京 会議 プロジェクト0', '0996fea87104119898e02a0d9962c82a2dfe8c52e32205dc818277bcf516daf6', 'tenant-c の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.609Z", "kind": "stated", "speaker": "user", "sourceObservationId": "dca56308-506e-4890-acdf-80f1c0a56318"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.612+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.233+09', 'ready', NULL, '2026-09-27 17:26:36.613422+09', '2026-09-27 17:26:36.860697+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8bdb9539-6cee-4c87-b970-398670001e33', 'tenant-c', NULL, 'ef20eac0-183a-441d-ae4c-d1208bbc60b9', 'v1', 'tenant-c の記憶 2 東京 会議 プロジェクト2', '2576291adf7ad31335c6494eb95a197053599c859b1067bc5f6b08c63fbd8fc2', 'tenant-c の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.580Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ef20eac0-183a-441d-ae4c-d1208bbc60b9"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.582+09', '2026-09-27 17:26:36.895+09', NULL, NULL, 1, 720, '2027-02-04 09:13:54.516+09', 'ready', NULL, '2026-09-27 17:26:36.583485+09', '2026-09-27 17:26:36.895644+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c7c688dc-642b-4b66-9d7a-625d7f166747', 'tenant-c', NULL, '07f7c76f-ca1a-4a1a-bd40-290f824bc913', 'v1', 'tenant-c の記憶 0 東京 会議 プロジェクト0', '0d78da8c6a4e2de262064e70959180f45578ab348746afc04814736d3ec98420', 'tenant-c の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.562Z", "kind": "stated", "speaker": "user", "sourceObservationId": "07f7c76f-ca1a-4a1a-bd40-290f824bc913"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.565+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.186+09', 'ready', NULL, '2026-09-27 17:26:36.566389+09', '2026-09-27 17:26:36.69017+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('12bc3c7c-49cd-4bdb-ac65-82d3d6b2a0f2', 'tenant-c', NULL, 'a236e2c9-4422-420d-983f-7afb3ec2c0f7', 'v1', 'tenant-c FAIL 埋め込み失敗 東京', '985f97e69b2fc62b500ebd50803bce5a72393d80852f55d01d88a21002fd7746', 'tenant-c FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.676Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a236e2c9-4422-420d-983f-7afb3ec2c0f7"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.679+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.3+09', 'failed', NULL, '2026-09-27 17:26:36.680398+09', '2026-09-27 17:26:36.789441+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d917040d-a6b3-4dcc-8aac-1a822196a330', 'tenant-c', NULL, '56869e20-27db-4d56-a4b8-b3a426bd4284', 'v1', 'tenant-c 未埋め込み 0', 'dbbed7a9da3bc87703ee74ec7fcbae128292a28245a094e1e7fe55b2e761766d', 'tenant-c 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.794Z", "kind": "stated", "speaker": "user", "sourceObservationId": "56869e20-27db-4d56-a4b8-b3a426bd4284"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.798+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.419+09', 'pending', NULL, '2026-09-27 17:26:36.799006+09', '2026-09-27 17:26:36.799006+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('5a2b10b7-567e-4ecb-9e23-ec177a527a23', 'tenant-c', NULL, 'cbe892f1-2b9d-47ef-9adf-7a52a8a3811e', 'v1', 'tenant-c 未埋め込み 1', '6fef40b085316dc1f9517118e7701e59fddc1231ce2b4b7b03aaf45936697d74', 'tenant-c 未埋め込み 1', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.806Z", "kind": "stated", "speaker": "user", "sourceObservationId": "cbe892f1-2b9d-47ef-9adf-7a52a8a3811e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.81+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.431+09', 'pending', NULL, '2026-09-27 17:26:36.811593+09', '2026-09-27 17:26:36.811593+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6cb9bde5-b389-4f27-a21a-0b53b034518a', 'tenant-c', NULL, '79052058-3c32-4ec2-a1f0-bbe5cb83391b', 'v1', 'tenant-c 未埋め込み 2', 'd4169a93c46303e6cc20af167d50c6ffb9c86896911949620cd36e561554b6c1', 'tenant-c 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.817Z", "kind": "stated", "speaker": "user", "sourceObservationId": "79052058-3c32-4ec2-a1f0-bbe5cb83391b"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.821+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.442+09', 'skipped', NULL, '2026-09-27 17:26:36.82162+09', '2026-09-27 17:26:36.827091+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e06636e2-bed7-489d-8e79-0fda31d3e677', 'tenant-c', NULL, 'f29f1603-e28e-410a-a732-e9aab6e29fbe', 'v1', 'tenant-c の記憶 8 東京 会議 プロジェクト3', '27955d03f0fb4db217579a1e5dbf74beed76d3f569305b1ab21cd24db6b92e36', 'tenant-c の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.635Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f29f1603-e28e-410a-a732-e9aab6e29fbe"}', 'contested', NULL, '176f8c3f-3d62-4bf3-8809-3632fa31b276', '{}', NULL, '2026-09-27 17:26:36.638+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.259+09', 'ready', NULL, '2026-09-27 17:26:36.63953+09', '2026-09-27 17:26:36.831465+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('053401d5-8023-4bf4-b025-0286d4791c25', 'tenant-c', NULL, '9ff6e3eb-de0b-4808-984b-a6b10babbcf7', 'v1', 'tenant-c の記憶 9 東京 会議 プロジェクト4', 'd8961ae07e5a93b6b0dc84ea6ee4aa46d7a585e6dfcbda5aaddc38a2ce3974b6', 'tenant-c の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.647Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9ff6e3eb-de0b-4808-984b-a6b10babbcf7"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.651+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.272+09', 'ready', NULL, '2026-09-27 17:26:36.651558+09', '2026-09-27 17:26:36.837462+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('050dbf24-786a-457a-a9a1-db662bdaefce', 'tenant-c', NULL, 'e223186b-7ebe-4bc6-ac71-5d1bd2834b0e', 'v1', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', 'be6295fd3fa665a4400e99e456e7ac4a6311b950abd5ab167494cf5cf1661dc4', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.657Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e223186b-7ebe-4bc6-ac71-5d1bd2834b0e"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.661+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.282+09', 'ready', NULL, '2026-09-27 17:26:36.661724+09', '2026-09-27 17:26:36.840204+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('5ede7b84-a4b3-4e81-92cc-b60567016bc7', 'tenant-c', NULL, 'ddcceee8-1683-4bb8-b75c-3c6b4fade0ca', 'v1', '[purged]', '90508b50cef379d5c03fa9f0c876b432c0e3fe77e30b0a0ccc82349c9d4a406f', '[purged]', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.667Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ddcceee8-1683-4bb8-b75c-3c6b4fade0ca"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.67+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.291+09', 'ready', '2026-09-27 17:26:36.849119+09', '2026-09-27 17:26:36.670954+09', '2026-09-27 17:26:36.849119+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('743d5edb-6f67-4fda-858b-611076d4641b', 'tenant-a2', NULL, 'da2b795b-b8ef-46f6-bf4a-866df273bd97', 'v1', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', 'a785d27623732af65fc0f05c80ea5e8638cd85eb944016167297bd92393c0331', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.926Z", "kind": "stated", "speaker": "user", "sourceObservationId": "da2b795b-b8ef-46f6-bf4a-866df273bd97"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.929+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.55+09', 'ready', NULL, '2026-09-27 17:26:36.929496+09', '2026-09-27 17:26:37.029766+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a65aa649-b580-47bb-bab4-081595b2bcc9', 'tenant-a2', NULL, '5f1cd1ec-037a-47e7-8ad5-72745a7ac488', 'v1', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', '2ff9054147bebbf3ab7b87786763739a75177d4a5b1f441bea040bf1eca421f4', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.943Z", "kind": "stated", "speaker": "user", "sourceObservationId": "5f1cd1ec-037a-47e7-8ad5-72745a7ac488"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.946+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.567+09', 'ready', NULL, '2026-09-27 17:26:36.947055+09', '2026-09-27 17:26:37.042675+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d157ac3e-7765-46c4-9eda-63859fe6c725', 'tenant-a2', NULL, '02642894-01b0-4f50-859d-115baeb9896e', 'v1', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', '914fb28b9e9744124fe125428a1d2ccdd0770428843fc02994496676178c35ee', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.960Z", "kind": "stated", "speaker": "user", "sourceObservationId": "02642894-01b0-4f50-859d-115baeb9896e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.969+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.59+09', 'ready', NULL, '2026-09-27 17:26:36.970524+09', '2026-09-27 17:26:37.053014+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('564e29cc-ca3d-479e-8e54-8e89fe2c3a8e', 'tenant-a2', NULL, '14d5b8c8-208c-4ec8-92f4-5f9974d2c57d', 'v1', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', '24ab90528718614c3e988124ed86cb1748700763560be7ef27c8bf4b5dcfd1ab', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.934Z", "kind": "stated", "speaker": "user", "sourceObservationId": "14d5b8c8-208c-4ec8-92f4-5f9974d2c57d"}', 'superseded', 'a65aa649-b580-47bb-bab4-081595b2bcc9', NULL, '{}', NULL, '2026-09-27 17:26:36.937+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.558+09', 'ready', NULL, '2026-09-27 17:26:36.937857+09', '2026-09-27 17:26:37.100546+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c1fc0bbc-6b41-484f-9f7a-cc60a61117d1', 'tenant-a2', NULL, '3647524f-a6ca-476f-ba99-224db9ecb6c0', 'v1', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', '7592207a458219fa91a20d15fb9715e0462c1b13647e460421449a8734cc3f3b', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.951Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3647524f-a6ca-476f-ba99-224db9ecb6c0"}', 'contested', NULL, '1fb5aae5-93d0-499f-ac6b-d089d0e86c49', '{}', NULL, '2026-09-27 17:26:36.954+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.575+09', 'ready', NULL, '2026-09-27 17:26:36.955107+09', '2026-09-27 17:26:37.103044+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b2a88277-3dac-4fba-aae1-35a4921cdde3', 'tenant-a2', NULL, '0114a4fc-8137-4e7d-a259-88fd0db95813', 'v1', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', '4cf1d599eeca369fd9803aad38e37386c99caf014b2df0588842e802cb851f62', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.917Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0114a4fc-8137-4e7d-a259-88fd0db95813"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.921+09', '2026-09-27 17:26:37.147+09', NULL, NULL, 1, 720, '2027-02-04 09:13:54.768+09', 'ready', NULL, '2026-09-27 17:26:36.921697+09', '2026-09-27 17:26:37.149261+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c7284c02-1343-4909-9e9c-c121d9c9ed48', 'tenant-a2', NULL, '93f2966a-7d81-4b49-ab2f-7634d114abeb', 'v1', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', 'cc6965c4ce873014f25affb39c4d6773bd8fb57667bfa6de70490b30eeb8b9c2', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.900Z", "kind": "stated", "speaker": "user", "sourceObservationId": "93f2966a-7d81-4b49-ab2f-7634d114abeb"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.903+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.524+09', 'ready', NULL, '2026-09-27 17:26:36.904082+09', '2026-09-27 17:26:37.00981+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c001b1d2-cd88-41a7-9d1c-da1d52f8af89', 'tenant-a2', NULL, '2820a427-c563-4e63-8a72-c7f1b3e4154c', 'v1', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', '98db05eaf2b468995ca8ddfb04238b6a3f78950faff175f1bfb6be45a8249e43', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.910Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2820a427-c563-4e63-8a72-c7f1b3e4154c"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.912+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.533+09', 'ready', NULL, '2026-09-27 17:26:36.913393+09', '2026-09-27 17:26:37.016401+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('724dd4fb-746a-4efb-87ac-cbcd1cdc0be1', 'tenant-a2', NULL, 'b330a75f-46af-4d2b-83b5-d81f6d19c162', 'v1', 'tenant-a2 FAIL 埋め込み失敗 東京', '72456a5d7a68e3f7d1e7d082bd8429d137478336dc0b7ab44c25aae0508cf9c7', 'tenant-a2 FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.996Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b330a75f-46af-4d2b-83b5-d81f6d19c162"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.999+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.62+09', 'failed', NULL, '2026-09-27 17:26:37.000429+09', '2026-09-27 17:26:37.070942+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('153bfe51-2ed7-47c6-bd81-2474f0a6dd9f', 'tenant-a2', NULL, '1ffd5093-cc34-4385-89ca-8384ccdfd860', 'v1', 'tenant-a2 未埋め込み 2', '361bf58e0bbb5d4804764e21fd48bddde845290c4fcd3281b746852036325696', 'tenant-a2 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-27T08:26:37.090Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1ffd5093-cc34-4385-89ca-8384ccdfd860"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 17:26:37.093+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.714+09', 'skipped', NULL, '2026-09-27 17:26:37.093792+09', '2026-09-27 17:26:37.098515+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1fb5aae5-93d0-499f-ac6b-d089d0e86c49', 'tenant-a2', NULL, 'a5d9a67a-bd0d-498c-aa4f-da735c6b6385', 'v1', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', '97de39f5fe1e8a6b2164b4726c2ae28bd112a4222632a171a6a79d866131fa79', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.976Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a5d9a67a-bd0d-498c-aa4f-da735c6b6385"}', 'contested', NULL, 'c1fc0bbc-6b41-484f-9f7a-cc60a61117d1', '{}', NULL, '2026-09-27 17:26:36.98+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.601+09', 'ready', NULL, '2026-09-27 17:26:36.981233+09', '2026-09-27 17:26:37.103044+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6f115c2d-8b9b-4a69-8a2a-4ab9e8f0e7b3', 'tenant-a2', NULL, '96a41fc0-eccb-4484-a5eb-e8eb172b3b74', 'v1', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', 'f43da00aa2d66eb30de895210fc22e5cba0548b91eb41edc808208389480c46c', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-27T08:26:36.987Z", "kind": "stated", "speaker": "user", "sourceObservationId": "96a41fc0-eccb-4484-a5eb-e8eb172b3b74"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-27 17:26:36.99+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.611+09', 'ready', NULL, '2026-09-27 17:26:36.99086+09', '2026-09-27 17:26:37.108474+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('599e874e-db44-4d71-8044-aebc72938e40', 'tenant-a2', NULL, 'c9c061b1-19df-4773-9699-580c1771047d', 'v1', 'tenant-a2 未埋め込み 0', '096af51a3f55ac6f12d4f7ae6b8dadd71299c722c9f56ac9764db3bd05d536e4', 'tenant-a2 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-27T08:26:37.074Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c9c061b1-19df-4773-9699-580c1771047d"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 17:26:37.076+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.697+09', 'pending', NULL, '2026-09-27 17:26:37.076696+09', '2026-09-27 17:26:37.110931+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e7585560-52f7-440d-ab25-82cf1e5d31e9', 'tenant-a2', NULL, 'c7a2aec3-497e-4a25-a2df-a1ce9e70d7af', 'v1', '[purged]', 'e78005a62ce1fe1dc602590187cd521751267c830e60191f8b6622dafb10a298', '[purged]', 'llm', 'stated', '{"at": "2026-09-27T08:26:37.082Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c7a2aec3-497e-4a25-a2df-a1ce9e70d7af"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 17:26:37.084+09', NULL, NULL, NULL, 1, 720, '2027-02-04 09:13:54.705+09', 'pending', '2026-09-27 17:26:37.117323+09', '2026-09-27 17:26:37.085398+09', '2026-09-27 17:26:37.117323+09', NULL, NULL, NULL, '{}', NULL, NULL);


--
-- Data for Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'c7c688dc-642b-4b66-9d7a-625d7f166747', '[16,772,45,207]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 17:26:36.688568+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'ce0f3b70-1463-4ba7-aa80-0bebad9188bd', '[16,773,45,208]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 17:26:36.695846+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '8bdb9539-6cee-4c87-b970-398670001e33', '[16,774,45,209]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 17:26:36.704526+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '1e8ced31-96c4-4001-bfb8-83fab2066475', '[0,0,0,0]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 17:26:36.712317+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '17973227-9578-4d24-a11e-ed82b1a18dfe', '[16,776,45,211]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 17:26:36.720546+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '773290c4-be30-41a2-bee6-97c76e908090', '[16,777,45,207]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 17:26:36.727182+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '176f8c3f-3d62-4bf3-8809-3632fa31b276', '[16,778,45,208]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 17:26:36.734314+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '7e362988-a627-4473-8a3c-207b893df777', '[16,779,45,209]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 17:26:36.740776+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'e06636e2-bed7-489d-8e79-0fda31d3e677', '[16,780,45,210]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 17:26:36.749112+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '053401d5-8023-4bf4-b025-0286d4791c25', '[16,781,45,211]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 17:26:36.759368+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '050dbf24-786a-457a-a9a1-db662bdaefce', '[0,0,0,0]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 17:26:36.77202+09');


--
-- Data for Name: memory_embeddings_test_fixture_model_3; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '603bd1d7-ad6e-4be4-950e-26058d1e381a', '[677,880,478]', 'fixture-model', '2026-09-27 17:26:35.900229+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '315c766c-88ec-4aec-879e-46becac0e106', '[678,881,478]', 'fixture-model', '2026-09-27 17:26:35.911263+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '37bcb397-24bd-48ac-a58b-dcef8f8b7661', '[679,882,478]', 'fixture-model', '2026-09-27 17:26:35.919218+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '937a0ddb-31e4-400c-bb04-602644bf0f29', '[0,0,0]', 'fixture-model', '2026-09-27 17:26:35.926348+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'fbd2137c-6d45-4ae6-a861-6063be83dfca', '[681,884,478]', 'fixture-model', '2026-09-27 17:26:35.934501+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'f84da5fa-5216-4cac-9f7f-f1416c88669a', '[677,885,478]', 'fixture-model', '2026-09-27 17:26:35.942063+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '531faf45-6027-4cb6-ae98-ad649a330750', '[678,886,478]', 'fixture-model', '2026-09-27 17:26:35.950513+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'c0018122-60ce-4424-ad53-8f60715b9cbd', '[679,887,478]', 'fixture-model', '2026-09-27 17:26:35.957598+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'd51c9734-c69a-4b73-8477-1ebfdf639af2', '[680,888,478]', 'fixture-model', '2026-09-27 17:26:35.963718+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'ab6b5ced-2f58-441a-b246-080f679e716f', '[681,889,478]', 'fixture-model', '2026-09-27 17:26:35.970348+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'd9a771ce-7838-4aa3-bb79-68258516cf55', '[0,0,0]', 'fixture-model', '2026-09-27 17:26:35.97667+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '328cd828-8369-4e71-9b7c-be834684f172', '[855,769,464]', 'fixture-model', '2026-09-27 17:26:35.989908+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'fd0091ab-fb3e-47ae-abdb-721f489eaa2c', '[855,770,465]', 'fixture-model', '2026-09-27 17:26:35.99592+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '320440dd-9312-45b2-9d54-40f967e9284d', '[855,771,466]', 'fixture-model', '2026-09-27 17:26:36.002517+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '18e03139-30b2-4af2-b2e6-0d716498ab9c', '[855,767,467]', 'fixture-model', '2026-09-27 17:26:36.009533+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'c7cc1eab-71b0-4171-b1cd-dd2e45f437b3', '[855,768,468]', 'fixture-model', '2026-09-27 17:26:36.016014+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '83d44a87-2717-4941-9dca-cb04401c0f3a', '[0,0,0]', 'fixture-model', '2026-09-27 17:26:36.02321+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '891e6d25-c61b-4e89-ab22-3cbb648d5bbb', '[855,770,470]', 'fixture-model', '2026-09-27 17:26:36.032613+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '73c39b8f-033e-490a-89e4-e8462dd18fc8', '[855,771,471]', 'fixture-model', '2026-09-27 17:26:36.040368+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '6a49af7d-5d1b-4ef4-a1f8-464a557668c0', '[855,768,462]', 'fixture-model', '2026-09-27 17:26:36.047154+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'b43cb04f-a124-4399-ba56-13035c654ac1', '[855,769,463]', 'fixture-model', '2026-09-27 17:26:36.056812+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'c9cc58ac-32b7-4891-b5c0-8025884d8703', '[855,770,464]', 'fixture-model', '2026-09-27 17:26:36.063014+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'a969f669-00e9-4797-9f48-34a1a6fc16b6', '[855,771,465]', 'fixture-model', '2026-09-27 17:26:36.069706+09');


--
-- Data for Name: memory_embeddings_testkit_deterministic_8; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'c5033310-c878-4ba9-8794-43c0f5fb35e5', '[839,69,404,38,174,703,638,168]', 'deterministic', '2026-09-27 17:26:36.385918+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'f387983a-c837-441e-959b-c23f20ad8d66', '[839,69,404,39,174,704,638,168]', 'deterministic', '2026-09-27 17:26:36.392061+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'c3da3459-3ec9-4f3f-9888-fe229dca53ff', '[839,69,404,40,174,705,638,168]', 'deterministic', '2026-09-27 17:26:36.397274+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '0f9c4e4e-e032-4b59-bf58-8823843b4e35', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-27 17:26:36.403879+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '09092d23-aabc-4d1c-af04-6652a4895738', '[839,69,404,42,174,707,638,168]', 'deterministic', '2026-09-27 17:26:36.40927+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'f1160e8a-c2f0-4577-b634-5a6479ffd228', '[839,69,404,38,174,708,638,168]', 'deterministic', '2026-09-27 17:26:36.413876+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '29186798-1902-47d4-8c0b-9ff615a52b07', '[839,69,404,39,174,709,638,168]', 'deterministic', '2026-09-27 17:26:36.418206+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'e8702899-a403-49e2-affa-6113c6f4ac50', '[839,69,404,40,174,710,638,168]', 'deterministic', '2026-09-27 17:26:36.422755+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'e1dfe4d9-6d5a-470d-8a6f-98374b0487a3', '[839,69,404,41,174,711,638,168]', 'deterministic', '2026-09-27 17:26:36.427541+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '8c3351de-f808-4dc4-98d7-c8185e9ed5fb', '[839,69,404,42,174,712,638,168]', 'deterministic', '2026-09-27 17:26:36.432898+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '7ce0c761-95d5-449b-832c-f96e8c75e7f8', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-27 17:26:36.439438+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'e857ce21-e916-415a-a351-8525f01fa2f2', '[218,229,101,23,993,197,634,691]', 'deterministic', '2026-09-27 17:26:36.450709+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '06328de7-b40a-4e80-9628-49d3dd977ff5', '[218,229,101,23,994,197,635,691]', 'deterministic', '2026-09-27 17:26:36.455813+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '113c85be-2a5c-4010-bc1d-7ec8474c262b', '[218,229,101,23,995,197,636,691]', 'deterministic', '2026-09-27 17:26:36.461386+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '487c1ffc-1b58-4795-afc0-45d6dafdb200', '[218,229,101,23,991,197,637,691]', 'deterministic', '2026-09-27 17:26:36.468538+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'd1eb71b3-5dfa-4433-b45b-5b50f821a8af', '[218,229,101,23,992,197,638,691]', 'deterministic', '2026-09-27 17:26:36.475033+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'c4fe7115-cb76-4111-8d41-74de41cc1199', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-27 17:26:36.480378+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'c7284c02-1343-4909-9e9c-c121d9c9ed48', '[236,824,78,391,51,180,632,690]', 'deterministic', '2026-09-27 17:26:37.008643+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'c001b1d2-cd88-41a7-9d1c-da1d52f8af89', '[236,824,78,391,52,180,633,690]', 'deterministic', '2026-09-27 17:26:37.01526+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'b2a88277-3dac-4fba-aae1-35a4921cdde3', '[236,824,78,391,53,180,634,690]', 'deterministic', '2026-09-27 17:26:37.021676+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '743d5edb-6f67-4fda-858b-611076d4641b', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-27 17:26:37.028492+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '564e29cc-ca3d-479e-8e54-8e89fe2c3a8e', '[236,824,78,391,55,180,636,690]', 'deterministic', '2026-09-27 17:26:37.034661+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'a65aa649-b580-47bb-bab4-081595b2bcc9', '[236,824,78,391,51,180,637,690]', 'deterministic', '2026-09-27 17:26:37.040895+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'c1fc0bbc-6b41-484f-9f7a-cc60a61117d1', '[236,824,78,391,52,180,638,690]', 'deterministic', '2026-09-27 17:26:37.047158+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'd157ac3e-7765-46c4-9eda-63859fe6c725', '[236,824,78,391,53,180,639,690]', 'deterministic', '2026-09-27 17:26:37.051967+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '1fb5aae5-93d0-499f-ac6b-d089d0e86c49', '[236,824,78,391,54,180,640,690]', 'deterministic', '2026-09-27 17:26:37.057573+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '6f115c2d-8b9b-4a69-8a2a-4ab9e8f0e7b3', '[236,824,78,391,55,180,641,690]', 'deterministic', '2026-09-27 17:26:37.063696+09');


--
-- Data for Name: memory_events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_events VALUES ('c2a2272d-e9f8-40b4-a4b1-d0f414c38807', 'tenant-a', '603bd1d7-ad6e-4be4-950e-26058d1e381a', 'created', '2026-09-27 17:26:35.631+09', '{"type": "system"}', 'tenant-a の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2ec4c136-c6c9-45cb-b0bf-815c579352c9"}');
INSERT INTO public.memory_events VALUES ('f30a6a74-d7bd-4bf5-8e8b-d3d6255e3480', 'tenant-a', '315c766c-88ec-4aec-879e-46becac0e106', 'created', '2026-09-27 17:26:35.643+09', '{"type": "system"}', 'tenant-a の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "60a81646-0fb0-4f1b-9bef-784b5ebd0a2f"}');
INSERT INTO public.memory_events VALUES ('f669f684-1e91-49b8-bf85-097b796ad420', 'tenant-a', '37bcb397-24bd-48ac-a58b-dcef8f8b7661', 'created', '2026-09-27 17:26:35.653+09', '{"type": "system"}', 'tenant-a の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b92b183b-08e8-477a-b845-9ca850327687"}');
INSERT INTO public.memory_events VALUES ('37360f40-a70e-4a1d-bbac-b71a068d2963', 'tenant-a', '937a0ddb-31e4-400c-bb04-602644bf0f29', 'created', '2026-09-27 17:26:35.665+09', '{"type": "system"}', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a8da4ac0-abdb-4e3f-8877-197c43773745"}');
INSERT INTO public.memory_events VALUES ('0a226e00-1a90-457d-ad52-5046d486650b', 'tenant-a', 'fbd2137c-6d45-4ae6-a861-6063be83dfca', 'created', '2026-09-27 17:26:35.678+09', '{"type": "system"}', 'tenant-a の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6d10b834-cca1-4aa1-ba31-91e2c490bc09"}');
INSERT INTO public.memory_events VALUES ('b13d584f-26f3-4c18-9e8e-596bac344c13', 'tenant-a', 'f84da5fa-5216-4cac-9f7f-f1416c88669a', 'created', '2026-09-27 17:26:35.693+09', '{"type": "system"}', 'tenant-a の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e1d0b3b9-06b8-447f-9faa-4df5a0ecfdb3"}');
INSERT INTO public.memory_events VALUES ('e9a9d8ac-abd4-44c5-a50c-051579c59b7e', 'tenant-a', '531faf45-6027-4cb6-ae98-ad649a330750', 'created', '2026-09-27 17:26:35.703+09', '{"type": "system"}', 'tenant-a の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f753521f-2e25-4cb5-85cd-ff074011b5a6"}');
INSERT INTO public.memory_events VALUES ('769c6c4e-ba51-4455-b804-4753b76dab99', 'tenant-a', 'c0018122-60ce-4424-ad53-8f60715b9cbd', 'created', '2026-09-27 17:26:35.712+09', '{"type": "system"}', 'tenant-a の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e58095dd-c384-49a7-9922-bb2858bc6036"}');
INSERT INTO public.memory_events VALUES ('63d90334-ea4d-4e02-9168-042d6b8da33d', 'tenant-a', 'd51c9734-c69a-4b73-8477-1ebfdf639af2', 'created', '2026-09-27 17:26:35.73+09', '{"type": "system"}', 'tenant-a の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "607f39d7-2edf-42cf-88c9-10d420f0aa5f"}');
INSERT INTO public.memory_events VALUES ('f2e560ee-a282-4f2e-8f5c-cdbce5f169ca', 'tenant-a', 'ab6b5ced-2f58-441a-b246-080f679e716f', 'created', '2026-09-27 17:26:35.742+09', '{"type": "system"}', 'tenant-a の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "52d2cafd-4636-4094-a8a8-47f69ed72d55"}');
INSERT INTO public.memory_events VALUES ('fe147bf2-e995-43d4-bb2b-503649f9e2d8', 'tenant-a', 'd9a771ce-7838-4aa3-bb79-68258516cf55', 'created', '2026-09-27 17:26:35.753+09', '{"type": "system"}', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8f4ba517-90c3-456f-8c87-02527eb7bcd8"}');
INSERT INTO public.memory_events VALUES ('c4989653-1b4d-4351-8967-8164edbf886e', 'tenant-a', '3273cf62-0261-4c39-89d7-a561df70af7d', 'created', '2026-09-27 17:26:35.765+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "de7961a2-4764-4e1f-914f-62ebe80a5a52"}');
INSERT INTO public.memory_events VALUES ('dc16c43c-b105-4c28-a191-94037073747c', 'tenant-a', '328cd828-8369-4e71-9b7c-be834684f172', 'created', '2026-09-27 17:26:35.776+09', '{"type": "system"}', 'tenant-a の記憶 12 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "64260722-19c0-47ae-83b6-8f7864699f71"}');
INSERT INTO public.memory_events VALUES ('3a2ccdb9-9c45-42c4-a29d-a65e537eac2a', 'tenant-a', 'fd0091ab-fb3e-47ae-abdb-721f489eaa2c', 'created', '2026-09-27 17:26:35.786+09', '{"type": "system"}', 'tenant-a の記憶 13 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ab01e3cc-86ea-4ca4-a23f-a8cfea8e45f9"}');
INSERT INTO public.memory_events VALUES ('a229aac5-d7b0-4f4b-89a6-e7bedf421b38', 'tenant-a', '320440dd-9312-45b2-9d54-40f967e9284d', 'created', '2026-09-27 17:26:35.795+09', '{"type": "system"}', 'tenant-a の記憶 14 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "52e62322-c06d-4689-94af-2e3e11534711"}');
INSERT INTO public.memory_events VALUES ('37a40df9-1169-47a6-9a36-003541379073', 'tenant-a', '18e03139-30b2-4af2-b2e6-0d716498ab9c', 'created', '2026-09-27 17:26:35.803+09', '{"type": "system"}', 'tenant-a の記憶 15 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "60e3a87d-f8d0-43bd-989d-489387db8b9d"}');
INSERT INTO public.memory_events VALUES ('a8e05e1c-d630-4107-abe8-5ee28d75222e', 'tenant-a', 'c7cc1eab-71b0-4171-b1cd-dd2e45f437b3', 'created', '2026-09-27 17:26:35.812+09', '{"type": "system"}', 'tenant-a の記憶 16 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "caa8c67d-a62c-40ab-9561-780b9c7a7040"}');
INSERT INTO public.memory_events VALUES ('92941088-7120-459a-8d76-22c5bf6d18c6', 'tenant-a', '83d44a87-2717-4941-9dca-cb04401c0f3a', 'created', '2026-09-27 17:26:35.821+09', '{"type": "system"}', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "06cd2f83-edae-4ee8-b060-936a6a5e0ab2"}');
INSERT INTO public.memory_events VALUES ('7646552a-b19c-46e2-b41f-411a7eaa0aaa', 'tenant-a', '891e6d25-c61b-4e89-ab22-3cbb648d5bbb', 'created', '2026-09-27 17:26:35.83+09', '{"type": "system"}', 'tenant-a の記憶 18 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "7296c24f-a6b2-4c78-b5a3-76570891d8bc"}');
INSERT INTO public.memory_events VALUES ('ec2fa0bb-64ae-4a48-8198-d174a75a4836', 'tenant-a', '73c39b8f-033e-490a-89e4-e8462dd18fc8', 'created', '2026-09-27 17:26:35.84+09', '{"type": "system"}', 'tenant-a の記憶 19 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "53126ad7-d2e6-4c07-8aae-a427b9622807"}');
INSERT INTO public.memory_events VALUES ('bddb49c7-6d78-4834-b7b8-868b6d0a2b80', 'tenant-a', '6a49af7d-5d1b-4ef4-a1f8-464a557668c0', 'created', '2026-09-27 17:26:35.849+09', '{"type": "system"}', 'tenant-a の記憶 20 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "bd4375d3-d750-4edf-8a1d-e1ce96176ae4"}');
INSERT INTO public.memory_events VALUES ('f0a5e017-6876-4f27-8ccd-a7d2385eb855', 'tenant-a', 'b43cb04f-a124-4399-ba56-13035c654ac1', 'created', '2026-09-27 17:26:35.857+09', '{"type": "system"}', 'tenant-a の記憶 21 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "4ec8a0a8-7706-4607-b872-61ccd8587309"}');
INSERT INTO public.memory_events VALUES ('f12fe349-a700-4516-95e4-70dc8cd4ec05', 'tenant-a', 'c9cc58ac-32b7-4891-b5c0-8025884d8703', 'created', '2026-09-27 17:26:35.866+09', '{"type": "system"}', 'tenant-a の記憶 22 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "5e3a9113-7f50-426a-8313-8fae3d5ef17f"}');
INSERT INTO public.memory_events VALUES ('4ae6ce86-59a5-4abb-ae91-67a79f7f9bd6', 'tenant-a', 'a969f669-00e9-4797-9f48-34a1a6fc16b6', 'created', '2026-09-27 17:26:35.878+09', '{"type": "system"}', 'tenant-a の記憶 23 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "874422f5-8811-47f0-bfa8-0c01c09cde5a"}');
INSERT INTO public.memory_events VALUES ('ad07c8f1-2f0b-4172-8e04-3de57e28a066', 'tenant-a', '1990b7cf-4b34-4127-bc05-2b57ca8e6204', 'created', '2026-09-27 17:26:35.889+09', '{"type": "system"}', 'tenant-a FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ba566891-f636-4941-b313-af224382542f"}');
INSERT INTO public.memory_events VALUES ('85a30abd-924e-4ba9-83d1-77a752fd8a06', 'tenant-a', 'eb4c800b-4fcb-4ab7-9010-0c5becf8a23c', 'created', '2026-09-27 17:26:36.089+09', '{"type": "system"}', 'tenant-a 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "919b4f30-5a2b-4c09-a804-047a26f343bf"}');
INSERT INTO public.memory_events VALUES ('609bb24d-4b93-4cb9-8f72-a6a18ce740f3', 'tenant-a', '11fbbb9d-e670-4358-a572-e39af12247ba', 'created', '2026-09-27 17:26:36.098+09', '{"type": "system"}', 'tenant-a 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e466180c-70dc-4acc-9be0-6059048db745"}');
INSERT INTO public.memory_events VALUES ('589e04cb-5578-47ee-8286-cf12f91ecb56', 'tenant-a', '8fc143fc-d18b-4d3c-9dbf-592f5bdf9d93', 'created', '2026-09-27 17:26:36.108+09', '{"type": "system"}', 'tenant-a 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a53c5203-b4e5-4ca6-9f75-418681c84dbd"}');
INSERT INTO public.memory_events VALUES ('364d35ee-e5f5-40d7-89f8-2ba4d17c953e', 'tenant-a', '531faf45-6027-4cb6-ae98-ad649a330750', 'updated', '2026-09-27 17:26:36.12+09', '{"type": "system"}', 'tenant-a の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('8c1c2eb6-9f8a-40a5-b2b0-12090844af4c', 'tenant-a', 'd51c9734-c69a-4b73-8477-1ebfdf639af2', 'updated', '2026-09-27 17:26:36.121+09', '{"type": "system"}', 'tenant-a の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('02c21fe3-6b22-4dcf-adec-7e684d48d41a', 'tenant-a', 'd9a771ce-7838-4aa3-bb79-68258516cf55', 'forgotten', '2026-09-27 17:26:36.128+09', '{"type": "system"}', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('3e9972a7-ad10-494a-91e8-15401be86eca', 'tenant-a', '3273cf62-0261-4c39-89d7-a561df70af7d', 'forgotten', '2026-09-27 17:26:36.131+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('4f8c1c08-9aca-483a-90d2-00279ecd253b', 'tenant-a', '3273cf62-0261-4c39-89d7-a561df70af7d', 'purged', '2026-09-27 17:26:36.136+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('925b2670-5d2a-432c-bfdb-2ff7c7902656', 'tenant-b', 'c5033310-c878-4ba9-8794-43c0f5fb35e5', 'created', '2026-09-27 17:26:36.199+09', '{"type": "system"}', 'tenant-b の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8081bf55-caa1-4b69-b5bb-084207cdc5d0"}');
INSERT INTO public.memory_events VALUES ('2e0ff0b1-1b74-40b0-8479-fe9034da0172', 'tenant-b', 'f387983a-c837-441e-959b-c23f20ad8d66', 'created', '2026-09-27 17:26:36.225+09', '{"type": "system"}', 'tenant-b の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e48c0eeb-cc22-4516-a583-310f20b6e182"}');
INSERT INTO public.memory_events VALUES ('9229396d-29c6-4eff-a838-558d0286b3f3', 'tenant-b', 'c3da3459-3ec9-4f3f-9888-fe229dca53ff', 'created', '2026-09-27 17:26:36.234+09', '{"type": "system"}', 'tenant-b の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1f83e39e-d6ec-458b-b505-461efa599f7f"}');
INSERT INTO public.memory_events VALUES ('6e69a83a-accb-4eac-a1aa-f2e043191fa8', 'tenant-b', '0f9c4e4e-e032-4b59-bf58-8823843b4e35', 'created', '2026-09-27 17:26:36.241+09', '{"type": "system"}', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c390fdb8-ce15-4ab0-8310-9b615e4a3dc9"}');
INSERT INTO public.memory_events VALUES ('56f59e50-01a6-41ee-85eb-96d01cef272b', 'tenant-b', '09092d23-aabc-4d1c-af04-6652a4895738', 'created', '2026-09-27 17:26:36.25+09', '{"type": "system"}', 'tenant-b の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "09141171-b041-4047-9d5f-fe922042ff56"}');
INSERT INTO public.memory_events VALUES ('ade9a830-04fd-4b38-905f-c4f0afb93fb9', 'tenant-b', 'f1160e8a-c2f0-4577-b634-5a6479ffd228', 'created', '2026-09-27 17:26:36.263+09', '{"type": "system"}', 'tenant-b の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d5a1552c-ae89-4403-8823-c2301b71c756"}');
INSERT INTO public.memory_events VALUES ('ef146297-3de6-43d1-8f13-394d6a91f7a3', 'tenant-b', '29186798-1902-47d4-8c0b-9ff615a52b07', 'created', '2026-09-27 17:26:36.278+09', '{"type": "system"}', 'tenant-b の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "76328bf5-29fe-4f88-9452-4c3eb3b7c47e"}');
INSERT INTO public.memory_events VALUES ('846bdccc-3c48-49e0-8d03-825128321f7a', 'tenant-b', 'e8702899-a403-49e2-affa-6113c6f4ac50', 'created', '2026-09-27 17:26:36.285+09', '{"type": "system"}', 'tenant-b の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a39f03aa-2a7e-4091-809f-3b358d5d4a37"}');
INSERT INTO public.memory_events VALUES ('c6d2b427-2bb8-44e2-958b-2d54f26a0d0b', 'tenant-b', 'e1dfe4d9-6d5a-470d-8a6f-98374b0487a3', 'created', '2026-09-27 17:26:36.294+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "bc582561-d81f-4324-8387-7edb335017a4"}');
INSERT INTO public.memory_events VALUES ('527f0def-26ca-47c8-b44f-636ecf8e9e9c', 'tenant-b', '8c3351de-f808-4dc4-98d7-c8185e9ed5fb', 'created', '2026-09-27 17:26:36.302+09', '{"type": "system"}', 'tenant-b の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "93c40601-7bad-4270-8a6e-2bf49b370ef8"}');
INSERT INTO public.memory_events VALUES ('5f327a1f-063f-46d4-9b90-af3c30e9fb17', 'tenant-b', '7ce0c761-95d5-449b-832c-f96e8c75e7f8', 'created', '2026-09-27 17:26:36.31+09', '{"type": "system"}', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "34d110e2-5572-4fbc-943f-3af2161e9f34"}');
INSERT INTO public.memory_events VALUES ('8cb6c63f-8423-464d-820a-1ff8e993c8ed', 'tenant-b', '01a3dad3-85e2-4ec4-983b-f89ccb781630', 'created', '2026-09-27 17:26:36.318+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b76d551b-d658-4a44-8c0c-f8feb6753277"}');
INSERT INTO public.memory_events VALUES ('4f296c72-987c-4c2f-afb1-51ff9c7a22ce', 'tenant-b', 'e857ce21-e916-415a-a351-8525f01fa2f2', 'created', '2026-09-27 17:26:36.323+09', '{"type": "system"}', 'tenant-b の記憶 12 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8f287c02-9530-43eb-9ea0-2d552da1c655"}');
INSERT INTO public.memory_events VALUES ('68b3cd56-62b5-433e-8ab6-21d0834768be', 'tenant-b', '06328de7-b40a-4e80-9628-49d3dd977ff5', 'created', '2026-09-27 17:26:36.337+09', '{"type": "system"}', 'tenant-b の記憶 13 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "7be8c187-6ef0-484a-bd27-145347754c8b"}');
INSERT INTO public.memory_events VALUES ('a83db901-9594-4602-abe5-3f2888cf1bf6', 'tenant-b', '113c85be-2a5c-4010-bc1d-7ec8474c262b', 'created', '2026-09-27 17:26:36.347+09', '{"type": "system"}', 'tenant-b の記憶 14 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "aeff008b-66fa-46d9-8e1f-d50973fa7462"}');
INSERT INTO public.memory_events VALUES ('f171530d-bdef-42a3-9b1c-f9249ac839e2', 'tenant-b', '487c1ffc-1b58-4795-afc0-45d6dafdb200', 'created', '2026-09-27 17:26:36.354+09', '{"type": "system"}', 'tenant-b の記憶 15 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ff7241b1-7fa2-4cd4-9ff8-b319435ecc97"}');
INSERT INTO public.memory_events VALUES ('4396f594-60f7-47e7-8c22-e94e77c5f048', 'tenant-b', 'd1eb71b3-5dfa-4433-b45b-5b50f821a8af', 'created', '2026-09-27 17:26:36.362+09', '{"type": "system"}', 'tenant-b の記憶 16 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "fb698135-7690-4c80-9787-87b733e2ffaf"}');
INSERT INTO public.memory_events VALUES ('07572bce-4edf-459e-8e17-a816f498cd2a', 'tenant-b', 'c4fe7115-cb76-4111-8d41-74de41cc1199', 'created', '2026-09-27 17:26:36.37+09', '{"type": "system"}', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c2a0fcdf-0879-4b48-a587-12caae591b39"}');
INSERT INTO public.memory_events VALUES ('85ddb090-6e9d-4b49-ac1d-1326b45fcb16', 'tenant-b', '2c33c03c-2eb8-4608-8c05-1105ae1b6e9e', 'created', '2026-09-27 17:26:36.38+09', '{"type": "system"}', 'tenant-b FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "16faf11f-699f-4dd9-9c59-b90819d66069"}');
INSERT INTO public.memory_events VALUES ('300fa98e-221c-4447-99a2-a8e5a8850215', 'tenant-b', 'a06b4513-d95f-4536-a116-aa5ce2a02a5d', 'created', '2026-09-27 17:26:36.492+09', '{"type": "system"}', 'tenant-b 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1b56eb33-0cf9-4c14-a83b-86b6ead9ddef"}');
INSERT INTO public.memory_events VALUES ('86b43128-53c1-497f-9b80-e9a768db0175', 'tenant-b', 'bc21c13f-dadc-4a44-9a4e-2e86c70ce3ec', 'created', '2026-09-27 17:26:36.501+09', '{"type": "system"}', 'tenant-b 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a307973c-b938-4b8a-873e-54e5b05b5d32"}');
INSERT INTO public.memory_events VALUES ('d44e986b-bfb0-4c2b-924d-cb38de32b7c1', 'tenant-b', '3d39dc08-75d2-4d73-8504-2b36abecb7bd', 'created', '2026-09-27 17:26:36.508+09', '{"type": "system"}', 'tenant-b 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "738de718-2b91-4989-b0b1-e5a2c91b8e11"}');
INSERT INTO public.memory_events VALUES ('93a395c3-1154-4851-8916-cfec59a34474', 'tenant-b', '29186798-1902-47d4-8c0b-9ff615a52b07', 'updated', '2026-09-27 17:26:36.519+09', '{"type": "system"}', 'tenant-b の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('fc385c23-611a-4e5d-b273-ceacd3174fe5', 'tenant-b', 'e1dfe4d9-6d5a-470d-8a6f-98374b0487a3', 'updated', '2026-09-27 17:26:36.52+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('47d77128-10c6-438c-b00a-9012460c86de', 'tenant-b', '7ce0c761-95d5-449b-832c-f96e8c75e7f8', 'forgotten', '2026-09-27 17:26:36.525+09', '{"type": "system"}', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('47ae8ba6-eafc-40a5-88e5-d3634312c90e', 'tenant-b', '01a3dad3-85e2-4ec4-983b-f89ccb781630', 'forgotten', '2026-09-27 17:26:36.527+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('3880ed82-2f3a-444e-afef-155c1b2a7e0a', 'tenant-b', '01a3dad3-85e2-4ec4-983b-f89ccb781630', 'purged', '2026-09-27 17:26:36.53+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('812ec626-d6f3-486f-b048-efe04603df9d', 'tenant-b', 'e1dfe4d9-6d5a-470d-8a6f-98374b0487a3', 'forgotten', '2026-09-27 17:26:36.535+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "fixture: orphaned contested"}');
INSERT INTO public.memory_events VALUES ('87a50220-cc57-4a57-85e0-35566382e705', 'tenant-c', 'c7c688dc-642b-4b66-9d7a-625d7f166747', 'created', '2026-09-27 17:26:36.569+09', '{"type": "system"}', 'tenant-c の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "07f7c76f-ca1a-4a1a-bd40-290f824bc913"}');
INSERT INTO public.memory_events VALUES ('87fae52a-a641-4edb-9bc0-a6a391b7c2fd', 'tenant-c', 'ce0f3b70-1463-4ba7-aa80-0bebad9188bd', 'created', '2026-09-27 17:26:36.578+09', '{"type": "system"}', 'tenant-c の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6513b15b-a19b-461f-b004-4b2f1c8b8236"}');
INSERT INTO public.memory_events VALUES ('18d3c7f2-7efb-427a-aaea-e92ae3f5d8d1', 'tenant-c', '8bdb9539-6cee-4c87-b970-398670001e33', 'created', '2026-09-27 17:26:36.586+09', '{"type": "system"}', 'tenant-c の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ef20eac0-183a-441d-ae4c-d1208bbc60b9"}');
INSERT INTO public.memory_events VALUES ('571e2f19-d45e-4dbc-8eb1-f9176e5cc7db', 'tenant-c', '1e8ced31-96c4-4001-bfb8-83fab2066475', 'created', '2026-09-27 17:26:36.595+09', '{"type": "system"}', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "186851b6-5dab-4208-8a47-74679b18c535"}');
INSERT INTO public.memory_events VALUES ('64a947e0-9444-43d7-b857-3878ce27ff0b', 'tenant-c', '17973227-9578-4d24-a11e-ed82b1a18dfe', 'created', '2026-09-27 17:26:36.605+09', '{"type": "system"}', 'tenant-c の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f7b86ca3-c8dd-4685-8073-223c6ba4bdb9"}');
INSERT INTO public.memory_events VALUES ('decd4bee-f507-4f2f-8969-98345022551f', 'tenant-c', '773290c4-be30-41a2-bee6-97c76e908090', 'created', '2026-09-27 17:26:36.616+09', '{"type": "system"}', 'tenant-c の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "dca56308-506e-4890-acdf-80f1c0a56318"}');
INSERT INTO public.memory_events VALUES ('dce49571-75ee-4aa2-8daf-13b62d39e727', 'tenant-c', '176f8c3f-3d62-4bf3-8809-3632fa31b276', 'created', '2026-09-27 17:26:36.624+09', '{"type": "system"}', 'tenant-c の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "17aff098-781c-4e5b-923e-47bea2eb80ad"}');
INSERT INTO public.memory_events VALUES ('c1229199-4544-4eff-baed-1067ee644e4a', 'tenant-c', '7e362988-a627-4473-8a3c-207b893df777', 'created', '2026-09-27 17:26:36.633+09', '{"type": "system"}', 'tenant-c の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "85ee900e-3a10-4dc9-8589-61b94d7d0646"}');
INSERT INTO public.memory_events VALUES ('65f4e335-be36-4a9e-8c6a-365da0e93c68', 'tenant-c', 'e06636e2-bed7-489d-8e79-0fda31d3e677', 'created', '2026-09-27 17:26:36.642+09', '{"type": "system"}', 'tenant-c の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f29f1603-e28e-410a-a732-e9aab6e29fbe"}');
INSERT INTO public.memory_events VALUES ('143a43e2-4ccb-4136-aaed-e0e4af131cc5', 'tenant-c', '053401d5-8023-4bf4-b025-0286d4791c25', 'created', '2026-09-27 17:26:36.654+09', '{"type": "system"}', 'tenant-c の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9ff6e3eb-de0b-4808-984b-a6b10babbcf7"}');
INSERT INTO public.memory_events VALUES ('888167ad-a2ae-4c41-a10d-7ec8e35a86af', 'tenant-c', '050dbf24-786a-457a-a9a1-db662bdaefce', 'created', '2026-09-27 17:26:36.665+09', '{"type": "system"}', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e223186b-7ebe-4bc6-ac71-5d1bd2834b0e"}');
INSERT INTO public.memory_events VALUES ('c137822c-0099-406d-bb72-d0fe815359cd', 'tenant-c', '5ede7b84-a4b3-4e81-92cc-b60567016bc7', 'created', '2026-09-27 17:26:36.673+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ddcceee8-1683-4bb8-b75c-3c6b4fade0ca"}');
INSERT INTO public.memory_events VALUES ('168b47e9-afe0-418e-a9f3-059c0f0d5629', 'tenant-c', '12bc3c7c-49cd-4bdb-ac65-82d3d6b2a0f2', 'created', '2026-09-27 17:26:36.683+09', '{"type": "system"}', 'tenant-c FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a236e2c9-4422-420d-983f-7afb3ec2c0f7"}');
INSERT INTO public.memory_events VALUES ('e1d680c0-05fe-42d3-874d-2e79de0b7f40', 'tenant-c', 'd917040d-a6b3-4dcc-8aac-1a822196a330', 'created', '2026-09-27 17:26:36.803+09', '{"type": "system"}', 'tenant-c 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "56869e20-27db-4d56-a4b8-b3a426bd4284"}');
INSERT INTO public.memory_events VALUES ('95b6d850-0302-476c-b57f-37e8f25896c2', 'tenant-c', '5a2b10b7-567e-4ecb-9e23-ec177a527a23', 'created', '2026-09-27 17:26:36.814+09', '{"type": "system"}', 'tenant-c 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "cbe892f1-2b9d-47ef-9adf-7a52a8a3811e"}');
INSERT INTO public.memory_events VALUES ('c6146d67-497b-4d22-8070-8017edfe5073', 'tenant-c', '6cb9bde5-b389-4f27-a21a-0b53b034518a', 'created', '2026-09-27 17:26:36.824+09', '{"type": "system"}', 'tenant-c 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "79052058-3c32-4ec2-a1f0-bbe5cb83391b"}');
INSERT INTO public.memory_events VALUES ('9f5214bc-99c7-48e1-993a-0d0c8fc1fe4f', 'tenant-c', '176f8c3f-3d62-4bf3-8809-3632fa31b276', 'updated', '2026-09-27 17:26:36.834+09', '{"type": "system"}', 'tenant-c の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('6ac290e3-000a-46d8-9f8c-57d50c5fdc93', 'tenant-c', 'e06636e2-bed7-489d-8e79-0fda31d3e677', 'updated', '2026-09-27 17:26:36.835+09', '{"type": "system"}', 'tenant-c の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('d634ffd8-f588-46ab-a346-4fe6db9e0f0b', 'tenant-c', '050dbf24-786a-457a-a9a1-db662bdaefce', 'forgotten', '2026-09-27 17:26:36.842+09', '{"type": "system"}', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('a624e47f-ef04-4abe-b9ef-9c5530a9284a', 'tenant-c', '5ede7b84-a4b3-4e81-92cc-b60567016bc7', 'forgotten', '2026-09-27 17:26:36.845+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('431123f5-9517-43fe-a038-ed76977f8bdd', 'tenant-c', '5ede7b84-a4b3-4e81-92cc-b60567016bc7', 'purged', '2026-09-27 17:26:36.85+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('e4b6592e-01ae-45c2-a520-e7460c0faabf', 'tenant-c', '773290c4-be30-41a2-bee6-97c76e908090', 'forgotten', '2026-09-27 17:26:36.862+09', '{"type": "system"}', 'tenant-c の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "fixture: successor forgotten"}');
INSERT INTO public.memory_events VALUES ('801a9aee-f567-48b3-a660-d1f029ba25fb', 'tenant-a2', 'c7284c02-1343-4909-9e9c-c121d9c9ed48', 'created', '2026-09-27 17:26:36.907+09', '{"type": "system"}', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "93f2966a-7d81-4b49-ab2f-7634d114abeb"}');
INSERT INTO public.memory_events VALUES ('baebbc9d-74f8-4827-9a92-bcee92bf2fd0', 'tenant-a2', 'c001b1d2-cd88-41a7-9d1c-da1d52f8af89', 'created', '2026-09-27 17:26:36.915+09', '{"type": "system"}', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2820a427-c563-4e63-8a72-c7f1b3e4154c"}');
INSERT INTO public.memory_events VALUES ('47c62dd3-744b-4785-a883-83fa9c2e9578', 'tenant-a2', 'b2a88277-3dac-4fba-aae1-35a4921cdde3', 'created', '2026-09-27 17:26:36.924+09', '{"type": "system"}', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0114a4fc-8137-4e7d-a259-88fd0db95813"}');
INSERT INTO public.memory_events VALUES ('5dee55c0-4311-471f-b54e-2e61cf0e6167', 'tenant-a2', '743d5edb-6f67-4fda-858b-611076d4641b', 'created', '2026-09-27 17:26:36.932+09', '{"type": "system"}', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "da2b795b-b8ef-46f6-bf4a-866df273bd97"}');
INSERT INTO public.memory_events VALUES ('9dba60f3-00c9-4262-95e4-b4161ec73f2c', 'tenant-a2', '564e29cc-ca3d-479e-8e54-8e89fe2c3a8e', 'created', '2026-09-27 17:26:36.94+09', '{"type": "system"}', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "14d5b8c8-208c-4ec8-92f4-5f9974d2c57d"}');
INSERT INTO public.memory_events VALUES ('37755917-09ca-4b75-8288-f39e39ba3cf3', 'tenant-a2', 'a65aa649-b580-47bb-bab4-081595b2bcc9', 'created', '2026-09-27 17:26:36.949+09', '{"type": "system"}', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "5f1cd1ec-037a-47e7-8ad5-72745a7ac488"}');
INSERT INTO public.memory_events VALUES ('819f3619-135e-4017-bbc9-389184684b6f', 'tenant-a2', 'c1fc0bbc-6b41-484f-9f7a-cc60a61117d1', 'created', '2026-09-27 17:26:36.958+09', '{"type": "system"}', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3647524f-a6ca-476f-ba99-224db9ecb6c0"}');
INSERT INTO public.memory_events VALUES ('cb29b8d8-ab88-4bb2-9cab-0b11dcc948eb', 'tenant-a2', 'd157ac3e-7765-46c4-9eda-63859fe6c725', 'created', '2026-09-27 17:26:36.974+09', '{"type": "system"}', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "02642894-01b0-4f50-859d-115baeb9896e"}');
INSERT INTO public.memory_events VALUES ('cb9bb26f-df81-4879-97cf-ce85acb541ba', 'tenant-a2', '1fb5aae5-93d0-499f-ac6b-d089d0e86c49', 'created', '2026-09-27 17:26:36.984+09', '{"type": "system"}', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a5d9a67a-bd0d-498c-aa4f-da735c6b6385"}');
INSERT INTO public.memory_events VALUES ('19e70619-e5ed-4c31-a136-d91fe42e45c2', 'tenant-a2', '6f115c2d-8b9b-4a69-8a2a-4ab9e8f0e7b3', 'created', '2026-09-27 17:26:36.993+09', '{"type": "system"}', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "96a41fc0-eccb-4484-a5eb-e8eb172b3b74"}');
INSERT INTO public.memory_events VALUES ('39c5b90d-c4c9-41de-aaea-7a82a98252b7', 'tenant-a2', '724dd4fb-746a-4efb-87ac-cbcd1cdc0be1', 'created', '2026-09-27 17:26:37.003+09', '{"type": "system"}', 'tenant-a2 FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b330a75f-46af-4d2b-83b5-d81f6d19c162"}');
INSERT INTO public.memory_events VALUES ('dab8670c-3da3-4266-8fc9-7390ee753605', 'tenant-a2', '599e874e-db44-4d71-8044-aebc72938e40', 'created', '2026-09-27 17:26:37.079+09', '{"type": "system"}', 'tenant-a2 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c9c061b1-19df-4773-9699-580c1771047d"}');
INSERT INTO public.memory_events VALUES ('44d909d3-6a07-4a06-9b88-e49bf5c7bb3e', 'tenant-a2', 'e7585560-52f7-440d-ab25-82cf1e5d31e9', 'created', '2026-09-27 17:26:37.088+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c7a2aec3-497e-4a25-a2df-a1ce9e70d7af"}');
INSERT INTO public.memory_events VALUES ('cda53de1-a25e-40ce-8d3d-9f67e0fe31c1', 'tenant-a2', '153bfe51-2ed7-47c6-bd81-2474f0a6dd9f', 'created', '2026-09-27 17:26:37.096+09', '{"type": "system"}', 'tenant-a2 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1ffd5093-cc34-4385-89ca-8384ccdfd860"}');
INSERT INTO public.memory_events VALUES ('9273ea3b-a938-418b-bdbe-3e40505d82c2', 'tenant-a2', 'c1fc0bbc-6b41-484f-9f7a-cc60a61117d1', 'updated', '2026-09-27 17:26:37.105+09', '{"type": "system"}', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('8068450f-9a9e-4f70-aa35-07e806ebda17', 'tenant-a2', '1fb5aae5-93d0-499f-ac6b-d089d0e86c49', 'updated', '2026-09-27 17:26:37.106+09', '{"type": "system"}', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('fc1f0ef2-ad99-47ae-b9d7-3ef80b136f38', 'tenant-a2', '599e874e-db44-4d71-8044-aebc72938e40', 'forgotten', '2026-09-27 17:26:37.111+09', '{"type": "system"}', 'tenant-a2 未埋め込み 0', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('ddc0510d-0a9c-4531-bcd4-a8087c7e4f83', 'tenant-a2', 'e7585560-52f7-440d-ab25-82cf1e5d31e9', 'forgotten', '2026-09-27 17:26:37.114+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('5b6d21b1-ffa3-4718-ae69-88fb8071919e', 'tenant-a2', 'e7585560-52f7-440d-ab25-82cf1e5d31e9', 'purged', '2026-09-27 17:26:37.118+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "fixture"}');


--
-- Data for Name: memory_labels; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: observations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.observations VALUES ('2ec4c136-c6c9-45cb-b0bf-815c579352c9', 'tenant-a', NULL, 'tenant-a-ext-0', 'utterance', '{"text": "tenant-a の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 17:26:35.604+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('60a81646-0fb0-4f1b-9bef-784b5ebd0a2f', 'tenant-a', NULL, 'tenant-a-ext-1', 'utterance', '{"text": "tenant-a の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:35.635+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b92b183b-08e8-477a-b845-9ca850327687', 'tenant-a', NULL, 'tenant-a-ext-2', 'utterance', '{"text": "tenant-a の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 17:26:35.646+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a8da4ac0-abdb-4e3f-8877-197c43773745', 'tenant-a', NULL, 'tenant-a-ext-3', 'utterance', '{"text": "tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-27 17:26:35.655+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6d10b834-cca1-4aa1-ba31-91e2c490bc09', 'tenant-a', NULL, 'tenant-a-ext-4', 'utterance', '{"text": "tenant-a の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 17:26:35.668+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e1d0b3b9-06b8-447f-9faa-4df5a0ecfdb3', 'tenant-a', NULL, 'tenant-a-ext-5', 'utterance', '{"text": "tenant-a の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 17:26:35.681+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f753521f-2e25-4cb5-85cd-ff074011b5a6', 'tenant-a', NULL, 'tenant-a-ext-6', 'utterance', '{"text": "tenant-a の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:35.696+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e58095dd-c384-49a7-9922-bb2858bc6036', 'tenant-a', NULL, 'tenant-a-ext-7', 'utterance', '{"text": "tenant-a の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 17:26:35.705+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('607f39d7-2edf-42cf-88c9-10d420f0aa5f', 'tenant-a', NULL, 'tenant-a-ext-8', 'utterance', '{"text": "tenant-a の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 17:26:35.716+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('52d2cafd-4636-4094-a8a8-47f69ed72d55', 'tenant-a', NULL, 'tenant-a-ext-9', 'utterance', '{"text": "tenant-a の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 17:26:35.733+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8f4ba517-90c3-456f-8c87-02527eb7bcd8', 'tenant-a', NULL, 'tenant-a-ext-10', 'utterance', '{"text": "tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-09-27 17:26:35.745+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('de7961a2-4764-4e1f-914f-62ebe80a5a52', 'tenant-a', NULL, 'tenant-a-ext-11', 'utterance', '{"text": "tenant-a の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:35.756+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('64260722-19c0-47ae-83b6-8f7864699f71', 'tenant-a', NULL, 'tenant-a-ext-12', 'utterance', '{"text": "tenant-a の記憶 12 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 17:26:35.767+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ab01e3cc-86ea-4ca4-a23f-a8cfea8e45f9', 'tenant-a', NULL, 'tenant-a-ext-13', 'utterance', '{"text": "tenant-a の記憶 13 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 17:26:35.779+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('52e62322-c06d-4689-94af-2e3e11534711', 'tenant-a', NULL, 'tenant-a-ext-14', 'utterance', '{"text": "tenant-a の記憶 14 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 17:26:35.789+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('60e3a87d-f8d0-43bd-989d-489387db8b9d', 'tenant-a', NULL, 'tenant-a-ext-15', 'utterance', '{"text": "tenant-a の記憶 15 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 17:26:35.797+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('caa8c67d-a62c-40ab-9561-780b9c7a7040', 'tenant-a', NULL, 'tenant-a-ext-16', 'utterance', '{"text": "tenant-a の記憶 16 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:35.806+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('06cd2f83-edae-4ee8-b060-936a6a5e0ab2', 'tenant-a', NULL, 'tenant-a-ext-17', 'utterance', '{"text": "tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO", "speaker": "user"}', NULL, '2026-09-27 17:26:35.815+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('7296c24f-a6b2-4c78-b5a3-76570891d8bc', 'tenant-a', NULL, 'tenant-a-ext-18', 'utterance', '{"text": "tenant-a の記憶 18 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 17:26:35.824+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('53126ad7-d2e6-4c07-8aae-a427b9622807', 'tenant-a', NULL, 'tenant-a-ext-19', 'utterance', '{"text": "tenant-a の記憶 19 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 17:26:35.833+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('bd4375d3-d750-4edf-8a1d-e1ce96176ae4', 'tenant-a', NULL, 'tenant-a-ext-20', 'utterance', '{"text": "tenant-a の記憶 20 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 17:26:35.842+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('4ec8a0a8-7706-4607-b872-61ccd8587309', 'tenant-a', NULL, 'tenant-a-ext-21', 'utterance', '{"text": "tenant-a の記憶 21 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:35.851+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('5e3a9113-7f50-426a-8313-8fae3d5ef17f', 'tenant-a', NULL, 'tenant-a-ext-22', 'utterance', '{"text": "tenant-a の記憶 22 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 17:26:35.859+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('874422f5-8811-47f0-bfa8-0c01c09cde5a', 'tenant-a', NULL, 'tenant-a-ext-23', 'utterance', '{"text": "tenant-a の記憶 23 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 17:26:35.869+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ba566891-f636-4941-b313-af224382542f', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-27 17:26:35.882+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('919b4f30-5a2b-4c09-a804-047a26f343bf', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-27 17:26:36.081+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e466180c-70dc-4acc-9be0-6059048db745', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-27 17:26:36.091+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a53c5203-b4e5-4ca6-9f75-418681c84dbd', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-27 17:26:36.1+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('76dbac0f-76d8-41cd-aabd-bde06d898c7a', 'tenant-a', NULL, NULL, 'usage', '{"recallId": "4db76a55-011f-477a-a541-a8d3771e47bd", "usedMemoryIds": ["6a49af7d-5d1b-4ef4-a1f8-464a557668c0"]}', NULL, '2026-09-27 17:26:36.176+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8081bf55-caa1-4b69-b5bb-084207cdc5d0', 'tenant-b', NULL, 'tenant-b-ext-0', 'utterance', '{"text": "tenant-b の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 17:26:36.185+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e48c0eeb-cc22-4516-a583-310f20b6e182', 'tenant-b', NULL, 'tenant-b-ext-1', 'utterance', '{"text": "tenant-b の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:36.219+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1f83e39e-d6ec-458b-b505-461efa599f7f', 'tenant-b', NULL, 'tenant-b-ext-2', 'utterance', '{"text": "tenant-b の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 17:26:36.227+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c390fdb8-ce15-4ab0-8310-9b615e4a3dc9', 'tenant-b', NULL, 'tenant-b-ext-3', 'utterance', '{"text": "tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-27 17:26:36.236+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('09141171-b041-4047-9d5f-fe922042ff56', 'tenant-b', NULL, 'tenant-b-ext-4', 'utterance', '{"text": "tenant-b の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 17:26:36.244+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d5a1552c-ae89-4403-8823-c2301b71c756', 'tenant-b', NULL, 'tenant-b-ext-5', 'utterance', '{"text": "tenant-b の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 17:26:36.252+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('76328bf5-29fe-4f88-9452-4c3eb3b7c47e', 'tenant-b', NULL, 'tenant-b-ext-6', 'utterance', '{"text": "tenant-b の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:36.271+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a39f03aa-2a7e-4091-809f-3b358d5d4a37', 'tenant-b', NULL, 'tenant-b-ext-7', 'utterance', '{"text": "tenant-b の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 17:26:36.28+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('bc582561-d81f-4324-8387-7edb335017a4', 'tenant-b', NULL, 'tenant-b-ext-8', 'utterance', '{"text": "tenant-b の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 17:26:36.288+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('93c40601-7bad-4270-8a6e-2bf49b370ef8', 'tenant-b', NULL, 'tenant-b-ext-9', 'utterance', '{"text": "tenant-b の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 17:26:36.296+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('34d110e2-5572-4fbc-943f-3af2161e9f34', 'tenant-b', NULL, 'tenant-b-ext-10', 'utterance', '{"text": "tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-09-27 17:26:36.304+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b76d551b-d658-4a44-8c0c-f8feb6753277', 'tenant-b', NULL, 'tenant-b-ext-11', 'utterance', '{"text": "tenant-b の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:36.312+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8f287c02-9530-43eb-9ea0-2d552da1c655', 'tenant-b', NULL, 'tenant-b-ext-12', 'utterance', '{"text": "tenant-b の記憶 12 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 17:26:36.319+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('7be8c187-6ef0-484a-bd27-145347754c8b', 'tenant-b', NULL, 'tenant-b-ext-13', 'utterance', '{"text": "tenant-b の記憶 13 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 17:26:36.325+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('aeff008b-66fa-46d9-8e1f-d50973fa7462', 'tenant-b', NULL, 'tenant-b-ext-14', 'utterance', '{"text": "tenant-b の記憶 14 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 17:26:36.341+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ff7241b1-7fa2-4cd4-9ff8-b319435ecc97', 'tenant-b', NULL, 'tenant-b-ext-15', 'utterance', '{"text": "tenant-b の記憶 15 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 17:26:36.349+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('fb698135-7690-4c80-9787-87b733e2ffaf', 'tenant-b', NULL, 'tenant-b-ext-16', 'utterance', '{"text": "tenant-b の記憶 16 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:36.356+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c2a0fcdf-0879-4b48-a587-12caae591b39', 'tenant-b', NULL, 'tenant-b-ext-17', 'utterance', '{"text": "tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO", "speaker": "user"}', NULL, '2026-09-27 17:26:36.365+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('16faf11f-699f-4dd9-9c59-b90819d66069', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-27 17:26:36.373+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1b56eb33-0cf9-4c14-a83b-86b6ead9ddef', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-27 17:26:36.487+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a307973c-b938-4b8a-873e-54e5b05b5d32', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-27 17:26:36.494+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('738de718-2b91-4989-b0b1-e5a2c91b8e11', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-27 17:26:36.503+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('81060269-cc50-4857-9fb6-5c59e8626a15', 'tenant-b', NULL, NULL, 'usage', '{"recallId": "2c6d13e3-7274-44fd-83f8-61f7b12b4bf2", "usedMemoryIds": ["113c85be-2a5c-4010-bc1d-7ec8474c262b"]}', NULL, '2026-09-27 17:26:36.555+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('07f7c76f-ca1a-4a1a-bd40-290f824bc913', 'tenant-c', NULL, 'tenant-c-ext-0', 'utterance', '{"text": "tenant-c の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 17:26:36.562+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6513b15b-a19b-461f-b004-4b2f1c8b8236', 'tenant-c', NULL, 'tenant-c-ext-1', 'utterance', '{"text": "tenant-c の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:36.571+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ef20eac0-183a-441d-ae4c-d1208bbc60b9', 'tenant-c', NULL, 'tenant-c-ext-2', 'utterance', '{"text": "tenant-c の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 17:26:36.58+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('186851b6-5dab-4208-8a47-74679b18c535', 'tenant-c', NULL, 'tenant-c-ext-3', 'utterance', '{"text": "tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-27 17:26:36.588+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f7b86ca3-c8dd-4685-8073-223c6ba4bdb9', 'tenant-c', NULL, 'tenant-c-ext-4', 'utterance', '{"text": "tenant-c の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 17:26:36.598+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('dca56308-506e-4890-acdf-80f1c0a56318', 'tenant-c', NULL, 'tenant-c-ext-5', 'utterance', '{"text": "tenant-c の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 17:26:36.609+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('17aff098-781c-4e5b-923e-47bea2eb80ad', 'tenant-c', NULL, 'tenant-c-ext-6', 'utterance', '{"text": "tenant-c の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:36.618+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('85ee900e-3a10-4dc9-8589-61b94d7d0646', 'tenant-c', NULL, 'tenant-c-ext-7', 'utterance', '{"text": "tenant-c の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 17:26:36.626+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f29f1603-e28e-410a-a732-e9aab6e29fbe', 'tenant-c', NULL, 'tenant-c-ext-8', 'utterance', '{"text": "tenant-c の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 17:26:36.635+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9ff6e3eb-de0b-4808-984b-a6b10babbcf7', 'tenant-c', NULL, 'tenant-c-ext-9', 'utterance', '{"text": "tenant-c の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 17:26:36.647+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e223186b-7ebe-4bc6-ac71-5d1bd2834b0e', 'tenant-c', NULL, 'tenant-c-ext-10', 'utterance', '{"text": "tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-09-27 17:26:36.657+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ddcceee8-1683-4bb8-b75c-3c6b4fade0ca', 'tenant-c', NULL, 'tenant-c-ext-11', 'utterance', '{"text": "tenant-c の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:36.667+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a236e2c9-4422-420d-983f-7afb3ec2c0f7', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-27 17:26:36.676+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('56869e20-27db-4d56-a4b8-b3a426bd4284', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-27 17:26:36.794+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('cbe892f1-2b9d-47ef-9adf-7a52a8a3811e', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-27 17:26:36.806+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('79052058-3c32-4ec2-a1f0-bbe5cb83391b', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-27 17:26:36.817+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('68a25403-3ab6-477c-86c3-e0d055af674d', 'tenant-c', NULL, NULL, 'usage', '{"recallId": "58f3b994-e023-40fa-ac18-8c70b3f6ab8b", "usedMemoryIds": ["8bdb9539-6cee-4c87-b970-398670001e33"]}', NULL, '2026-09-27 17:26:36.893+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('93f2966a-7d81-4b49-ab2f-7634d114abeb', 'tenant-a2', NULL, 'tenant-a2-ext-0', 'utterance', '{"text": "tenant-a2 の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 17:26:36.9+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('2820a427-c563-4e63-8a72-c7f1b3e4154c', 'tenant-a2', NULL, 'tenant-a2-ext-1', 'utterance', '{"text": "tenant-a2 の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:36.91+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0114a4fc-8137-4e7d-a259-88fd0db95813', 'tenant-a2', NULL, 'tenant-a2-ext-2', 'utterance', '{"text": "tenant-a2 の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 17:26:36.917+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('da2b795b-b8ef-46f6-bf4a-866df273bd97', 'tenant-a2', NULL, 'tenant-a2-ext-3', 'utterance', '{"text": "tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-27 17:26:36.926+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('14d5b8c8-208c-4ec8-92f4-5f9974d2c57d', 'tenant-a2', NULL, 'tenant-a2-ext-4', 'utterance', '{"text": "tenant-a2 の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 17:26:36.934+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('5f1cd1ec-037a-47e7-8ad5-72745a7ac488', 'tenant-a2', NULL, 'tenant-a2-ext-5', 'utterance', '{"text": "tenant-a2 の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 17:26:36.943+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('3647524f-a6ca-476f-ba99-224db9ecb6c0', 'tenant-a2', NULL, 'tenant-a2-ext-6', 'utterance', '{"text": "tenant-a2 の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 17:26:36.951+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('02642894-01b0-4f50-859d-115baeb9896e', 'tenant-a2', NULL, 'tenant-a2-ext-7', 'utterance', '{"text": "tenant-a2 の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 17:26:36.96+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a5d9a67a-bd0d-498c-aa4f-da735c6b6385', 'tenant-a2', NULL, 'tenant-a2-ext-8', 'utterance', '{"text": "tenant-a2 の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 17:26:36.976+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('96a41fc0-eccb-4484-a5eb-e8eb172b3b74', 'tenant-a2', NULL, 'tenant-a2-ext-9', 'utterance', '{"text": "tenant-a2 の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 17:26:36.987+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b330a75f-46af-4d2b-83b5-d81f6d19c162', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-27 17:26:36.996+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c9c061b1-19df-4773-9699-580c1771047d', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-27 17:26:37.074+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c7a2aec3-497e-4a25-a2df-a1ce9e70d7af', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-27 17:26:37.082+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1ffd5093-cc34-4385-89ca-8384ccdfd860', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-27 17:26:37.09+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('2e8a58a5-58bf-4355-b268-09fea5eddea2', 'tenant-a2', NULL, NULL, 'usage', '{"recallId": "e2e55b54-18a8-42b5-a15b-3841292fbe48", "usedMemoryIds": ["b2a88277-3dac-4fba-aae1-35a4921cdde3"]}', NULL, '2026-09-27 17:26:37.145+09', NULL, NULL, '{}');


--
-- Data for Name: outbox; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.outbox VALUES ('adcc4e7b-f99b-454a-b001-c9611ceaf937', 'tenant-a', 'extract', '{"observationId": "2ec4c136-c6c9-45cb-b0bf-815c579352c9"}', '2026-09-27 17:26:35.606923+09', NULL, NULL, 0, '2026-09-27 17:26:35.634255+09', NULL, NULL, '2026-09-27 17:26:35.606923+09');
INSERT INTO public.outbox VALUES ('78435967-f267-4959-9c0e-d4429a73038d', 'tenant-a', 'extract', '{"observationId": "60a81646-0fb0-4f1b-9bef-784b5ebd0a2f"}', '2026-09-27 17:26:35.635982+09', NULL, NULL, 0, '2026-09-27 17:26:35.645628+09', NULL, NULL, '2026-09-27 17:26:35.635982+09');
INSERT INTO public.outbox VALUES ('5bf7f31f-6031-43db-b5cc-bc702f7202f5', 'tenant-a', 'extract', '{"observationId": "b92b183b-08e8-477a-b845-9ca850327687"}', '2026-09-27 17:26:35.646853+09', NULL, NULL, 0, '2026-09-27 17:26:35.654724+09', NULL, NULL, '2026-09-27 17:26:35.646853+09');
INSERT INTO public.outbox VALUES ('d9c5ffa5-bbda-4267-a80c-e8395c266216', 'tenant-a', 'extract', '{"observationId": "a8da4ac0-abdb-4e3f-8877-197c43773745"}', '2026-09-27 17:26:35.655635+09', NULL, NULL, 0, '2026-09-27 17:26:35.667149+09', NULL, NULL, '2026-09-27 17:26:35.655635+09');
INSERT INTO public.outbox VALUES ('69bc1217-4b08-4f12-9895-e1e5465975d8', 'tenant-a', 'extract', '{"observationId": "6d10b834-cca1-4aa1-ba31-91e2c490bc09"}', '2026-09-27 17:26:35.66859+09', NULL, NULL, 0, '2026-09-27 17:26:35.680163+09', NULL, NULL, '2026-09-27 17:26:35.66859+09');
INSERT INTO public.outbox VALUES ('74c3dc8b-4f11-4d73-bcba-61b4f641056e', 'tenant-a', 'extract', '{"observationId": "e1d0b3b9-06b8-447f-9faa-4df5a0ecfdb3"}', '2026-09-27 17:26:35.681193+09', NULL, NULL, 0, '2026-09-27 17:26:35.695368+09', NULL, NULL, '2026-09-27 17:26:35.681193+09');
INSERT INTO public.outbox VALUES ('7be6314a-895d-40f8-a9f9-8ba152dadffb', 'tenant-a', 'extract', '{"observationId": "f753521f-2e25-4cb5-85cd-ff074011b5a6"}', '2026-09-27 17:26:35.696514+09', NULL, NULL, 0, '2026-09-27 17:26:35.704825+09', NULL, NULL, '2026-09-27 17:26:35.696514+09');
INSERT INTO public.outbox VALUES ('1fafe81a-2309-4a88-b1f0-629cf206d65f', 'tenant-a', 'extract', '{"observationId": "e58095dd-c384-49a7-9922-bb2858bc6036"}', '2026-09-27 17:26:35.706119+09', NULL, NULL, 0, '2026-09-27 17:26:35.714224+09', NULL, NULL, '2026-09-27 17:26:35.706119+09');
INSERT INTO public.outbox VALUES ('66c274bf-a16c-4c8e-bd83-6ef367d3a16b', 'tenant-a', 'extract', '{"observationId": "607f39d7-2edf-42cf-88c9-10d420f0aa5f"}', '2026-09-27 17:26:35.716989+09', NULL, NULL, 0, '2026-09-27 17:26:35.732478+09', NULL, NULL, '2026-09-27 17:26:35.716989+09');
INSERT INTO public.outbox VALUES ('69028a20-2634-4bae-8b00-590b60b912b4', 'tenant-a', 'extract', '{"observationId": "52d2cafd-4636-4094-a8a8-47f69ed72d55"}', '2026-09-27 17:26:35.73407+09', NULL, NULL, 0, '2026-09-27 17:26:35.744415+09', NULL, NULL, '2026-09-27 17:26:35.73407+09');
INSERT INTO public.outbox VALUES ('ed698aa4-3f51-4d60-86fc-4d06e7660eaa', 'tenant-a', 'extract', '{"observationId": "8f4ba517-90c3-456f-8c87-02527eb7bcd8"}', '2026-09-27 17:26:35.745659+09', NULL, NULL, 0, '2026-09-27 17:26:35.755724+09', NULL, NULL, '2026-09-27 17:26:35.745659+09');
INSERT INTO public.outbox VALUES ('c1543884-3ee1-405e-9261-f5a680dbf2e7', 'tenant-a', 'extract', '{"observationId": "de7961a2-4764-4e1f-914f-62ebe80a5a52"}', '2026-09-27 17:26:35.756963+09', NULL, NULL, 0, '2026-09-27 17:26:35.766971+09', NULL, NULL, '2026-09-27 17:26:35.756963+09');
INSERT INTO public.outbox VALUES ('6541f506-d018-48c0-b590-cd1b8edb5150', 'tenant-a', 'extract', '{"observationId": "64260722-19c0-47ae-83b6-8f7864699f71"}', '2026-09-27 17:26:35.768102+09', NULL, NULL, 0, '2026-09-27 17:26:35.777837+09', NULL, NULL, '2026-09-27 17:26:35.768102+09');
INSERT INTO public.outbox VALUES ('cace4246-df54-40b1-b9b4-3c0a8af3db51', 'tenant-a', 'extract', '{"observationId": "ab01e3cc-86ea-4ca4-a23f-a8cfea8e45f9"}', '2026-09-27 17:26:35.779202+09', NULL, NULL, 0, '2026-09-27 17:26:35.788365+09', NULL, NULL, '2026-09-27 17:26:35.779202+09');
INSERT INTO public.outbox VALUES ('c2baba97-3a9a-42fe-b52d-a003ba04796e', 'tenant-a', 'extract', '{"observationId": "52e62322-c06d-4689-94af-2e3e11534711"}', '2026-09-27 17:26:35.789565+09', NULL, NULL, 0, '2026-09-27 17:26:35.796951+09', NULL, NULL, '2026-09-27 17:26:35.789565+09');
INSERT INTO public.outbox VALUES ('1974236f-27d2-4b58-baff-02ab97edebb0', 'tenant-a', 'extract', '{"observationId": "60e3a87d-f8d0-43bd-989d-489387db8b9d"}', '2026-09-27 17:26:35.798141+09', NULL, NULL, 0, '2026-09-27 17:26:35.805002+09', NULL, NULL, '2026-09-27 17:26:35.798141+09');
INSERT INTO public.outbox VALUES ('cacc31a7-2c29-455a-b424-32c11fedefdd', 'tenant-a', 'extract', '{"observationId": "caa8c67d-a62c-40ab-9561-780b9c7a7040"}', '2026-09-27 17:26:35.806474+09', NULL, NULL, 0, '2026-09-27 17:26:35.814227+09', NULL, NULL, '2026-09-27 17:26:35.806474+09');
INSERT INTO public.outbox VALUES ('a363c8d4-eab7-4f3f-9b47-8a066e1db61f', 'tenant-a', 'extract', '{"observationId": "06cd2f83-edae-4ee8-b060-936a6a5e0ab2"}', '2026-09-27 17:26:35.815425+09', NULL, NULL, 0, '2026-09-27 17:26:35.823337+09', NULL, NULL, '2026-09-27 17:26:35.815425+09');
INSERT INTO public.outbox VALUES ('776c9f2d-3799-4f0d-be95-46472fc611a5', 'tenant-a', 'extract', '{"observationId": "7296c24f-a6b2-4c78-b5a3-76570891d8bc"}', '2026-09-27 17:26:35.82446+09', NULL, NULL, 0, '2026-09-27 17:26:35.83244+09', NULL, NULL, '2026-09-27 17:26:35.82446+09');
INSERT INTO public.outbox VALUES ('44c2cd44-6da3-437f-ba01-3ee549894478', 'tenant-a', 'extract', '{"observationId": "53126ad7-d2e6-4c07-8aae-a427b9622807"}', '2026-09-27 17:26:35.833807+09', NULL, NULL, 0, '2026-09-27 17:26:35.841731+09', NULL, NULL, '2026-09-27 17:26:35.833807+09');
INSERT INTO public.outbox VALUES ('2a68ccef-aafb-47f8-8c5d-ee4e2326e080', 'tenant-a', 'extract', '{"observationId": "bd4375d3-d750-4edf-8a1d-e1ce96176ae4"}', '2026-09-27 17:26:35.84272+09', NULL, NULL, 0, '2026-09-27 17:26:35.850883+09', NULL, NULL, '2026-09-27 17:26:35.84272+09');
INSERT INTO public.outbox VALUES ('76cf8d9b-01bf-4428-8201-5a888eded67a', 'tenant-a', 'extract', '{"observationId": "4ec8a0a8-7706-4607-b872-61ccd8587309"}', '2026-09-27 17:26:35.851917+09', NULL, NULL, 0, '2026-09-27 17:26:35.858737+09', NULL, NULL, '2026-09-27 17:26:35.851917+09');
INSERT INTO public.outbox VALUES ('60a72404-c756-40d8-a5b0-4ae4eb144a4d', 'tenant-a', 'extract', '{"observationId": "5e3a9113-7f50-426a-8313-8fae3d5ef17f"}', '2026-09-27 17:26:35.859635+09', NULL, NULL, 0, '2026-09-27 17:26:35.867854+09', NULL, NULL, '2026-09-27 17:26:35.859635+09');
INSERT INTO public.outbox VALUES ('1f87ac6d-0a64-43a2-8979-36ea47f3b860', 'tenant-a', 'extract', '{"observationId": "874422f5-8811-47f0-bfa8-0c01c09cde5a"}', '2026-09-27 17:26:35.869414+09', NULL, NULL, 0, '2026-09-27 17:26:35.880969+09', NULL, NULL, '2026-09-27 17:26:35.869414+09');
INSERT INTO public.outbox VALUES ('ef74c50b-a1e2-45db-9f3e-ba49e511fca8', 'tenant-a', 'extract', '{"observationId": "ba566891-f636-4941-b313-af224382542f"}', '2026-09-27 17:26:35.882461+09', NULL, NULL, 0, '2026-09-27 17:26:35.891637+09', NULL, NULL, '2026-09-27 17:26:35.882461+09');
INSERT INTO public.outbox VALUES ('83726723-9c0b-464f-86b6-21f623b58b6d', 'tenant-a', 'embed', '{"memoryId": "603bd1d7-ad6e-4be4-950e-26058d1e381a"}', '2026-09-27 17:26:35.621636+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.908796+09', NULL, NULL, '2026-09-27 17:26:35.621636+09');
INSERT INTO public.outbox VALUES ('a199fbcf-d6ad-4f42-b8a1-21d37d247e51', 'tenant-a', 'embed', '{"memoryId": "315c766c-88ec-4aec-879e-46becac0e106"}', '2026-09-27 17:26:35.640443+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.916693+09', NULL, NULL, '2026-09-27 17:26:35.640443+09');
INSERT INTO public.outbox VALUES ('ceb825de-cf39-4df6-b177-b21e8c1f86d4', 'tenant-a', 'embed', '{"memoryId": "37bcb397-24bd-48ac-a58b-dcef8f8b7661"}', '2026-09-27 17:26:35.650371+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.92407+09', NULL, NULL, '2026-09-27 17:26:35.650371+09');
INSERT INTO public.outbox VALUES ('dd1b9456-1eeb-4144-b086-71e8350309d4', 'tenant-a', 'embed', '{"memoryId": "937a0ddb-31e4-400c-bb04-602644bf0f29"}', '2026-09-27 17:26:35.661257+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.931574+09', NULL, NULL, '2026-09-27 17:26:35.661257+09');
INSERT INTO public.outbox VALUES ('3e115f8d-3b69-47e5-b320-4977fb98e216', 'tenant-a', 'embed', '{"memoryId": "fbd2137c-6d45-4ae6-a861-6063be83dfca"}', '2026-09-27 17:26:35.674321+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.939704+09', NULL, NULL, '2026-09-27 17:26:35.674321+09');
INSERT INTO public.outbox VALUES ('c3ea78a2-8fc9-4517-ac61-b27f1ba4fb4b', 'tenant-a', 'embed', '{"memoryId": "f84da5fa-5216-4cac-9f7f-f1416c88669a"}', '2026-09-27 17:26:35.690017+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.947496+09', NULL, NULL, '2026-09-27 17:26:35.690017+09');
INSERT INTO public.outbox VALUES ('0fc785d3-39e9-42ff-8000-58d548ce79ba', 'tenant-a', 'embed', '{"memoryId": "531faf45-6027-4cb6-ae98-ad649a330750"}', '2026-09-27 17:26:35.700454+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.955458+09', NULL, NULL, '2026-09-27 17:26:35.700454+09');
INSERT INTO public.outbox VALUES ('a3357d6c-27df-4636-bcf3-c09cc80b2755', 'tenant-a', 'embed', '{"memoryId": "c0018122-60ce-4424-ad53-8f60715b9cbd"}', '2026-09-27 17:26:35.709697+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.961444+09', NULL, NULL, '2026-09-27 17:26:35.709697+09');
INSERT INTO public.outbox VALUES ('bbce1a54-ff4e-4fab-9060-1469c0c50a9f', 'tenant-a', 'embed', '{"memoryId": "d51c9734-c69a-4b73-8477-1ebfdf639af2"}', '2026-09-27 17:26:35.725622+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.968405+09', NULL, NULL, '2026-09-27 17:26:35.725622+09');
INSERT INTO public.outbox VALUES ('c92e5c7c-dd0c-4c2e-9390-ef00214bbe28', 'tenant-a', 'embed', '{"memoryId": "ab6b5ced-2f58-441a-b246-080f679e716f"}', '2026-09-27 17:26:35.738763+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.974514+09', NULL, NULL, '2026-09-27 17:26:35.738763+09');
INSERT INTO public.outbox VALUES ('670f0656-c627-4a86-ba39-412d2cded451', 'tenant-a', 'embed', '{"memoryId": "d9a771ce-7838-4aa3-bb79-68258516cf55"}', '2026-09-27 17:26:35.750082+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.981036+09', NULL, NULL, '2026-09-27 17:26:35.750082+09');
INSERT INTO public.outbox VALUES ('f6abf3fb-0c7b-42d7-9d66-b341dce2d2a9', 'tenant-a', 'embed', '{"memoryId": "3273cf62-0261-4c39-89d7-a561df70af7d"}', '2026-09-27 17:26:35.761265+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.987597+09', NULL, NULL, '2026-09-27 17:26:35.761265+09');
INSERT INTO public.outbox VALUES ('2263cbc5-0af6-4e06-9446-840b3cb36f31', 'tenant-a', 'embed', '{"memoryId": "328cd828-8369-4e71-9b7c-be834684f172"}', '2026-09-27 17:26:35.772377+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:35.994102+09', NULL, NULL, '2026-09-27 17:26:35.772377+09');
INSERT INTO public.outbox VALUES ('d8b5187e-f229-4a15-afeb-e78b02023e53', 'tenant-a', 'embed', '{"memoryId": "fd0091ab-fb3e-47ae-abdb-721f489eaa2c"}', '2026-09-27 17:26:35.783325+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:36.00021+09', NULL, NULL, '2026-09-27 17:26:35.783325+09');
INSERT INTO public.outbox VALUES ('fc7f0d60-dc40-4bdc-bbeb-2e25acce9b03', 'tenant-a', 'embed', '{"memoryId": "320440dd-9312-45b2-9d54-40f967e9284d"}', '2026-09-27 17:26:35.792804+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:36.007453+09', NULL, NULL, '2026-09-27 17:26:35.792804+09');
INSERT INTO public.outbox VALUES ('9659a1ac-6c62-4201-8ad8-ff6ee14ae0e8', 'tenant-a', 'embed', '{"memoryId": "18e03139-30b2-4af2-b2e6-0d716498ab9c"}', '2026-09-27 17:26:35.80112+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:36.013692+09', NULL, NULL, '2026-09-27 17:26:35.80112+09');
INSERT INTO public.outbox VALUES ('b149f047-b819-474e-a429-9c4d82b9bd01', 'tenant-a', 'embed', '{"memoryId": "c7cc1eab-71b0-4171-b1cd-dd2e45f437b3"}', '2026-09-27 17:26:35.809619+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:36.020851+09', NULL, NULL, '2026-09-27 17:26:35.809619+09');
INSERT INTO public.outbox VALUES ('24550ca3-4c04-410b-abb0-070333ac0442', 'tenant-a', 'embed', '{"memoryId": "83d44a87-2717-4941-9dca-cb04401c0f3a"}', '2026-09-27 17:26:35.818861+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:36.030054+09', NULL, NULL, '2026-09-27 17:26:35.818861+09');
INSERT INTO public.outbox VALUES ('c2660ae6-1c10-4c62-bee0-0195d853ccb3', 'tenant-a', 'embed', '{"memoryId": "891e6d25-c61b-4e89-ab22-3cbb648d5bbb"}', '2026-09-27 17:26:35.827349+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:36.038342+09', NULL, NULL, '2026-09-27 17:26:35.827349+09');
INSERT INTO public.outbox VALUES ('6d8dab6f-ab13-4cd6-a56d-fa621ec07264', 'tenant-a', 'embed', '{"memoryId": "73c39b8f-033e-490a-89e4-e8462dd18fc8"}', '2026-09-27 17:26:35.837089+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:36.04455+09', NULL, NULL, '2026-09-27 17:26:35.837089+09');
INSERT INTO public.outbox VALUES ('d8dc88d0-49a0-4551-a6d8-4085e6103191', 'tenant-a', 'embed', '{"memoryId": "6a49af7d-5d1b-4ef4-a1f8-464a557668c0"}', '2026-09-27 17:26:35.84656+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:36.054592+09', NULL, NULL, '2026-09-27 17:26:35.84656+09');
INSERT INTO public.outbox VALUES ('ea4898a4-66e8-475c-ae8e-01ab6b03f024', 'tenant-a', 'embed', '{"memoryId": "b43cb04f-a124-4399-ba56-13035c654ac1"}', '2026-09-27 17:26:35.85476+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:36.06085+09', NULL, NULL, '2026-09-27 17:26:35.85476+09');
INSERT INTO public.outbox VALUES ('b218bf95-7ca0-4273-9355-5617762182d9', 'tenant-a', 'embed', '{"memoryId": "c9cc58ac-32b7-4891-b5c0-8025884d8703"}', '2026-09-27 17:26:35.862926+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:36.067581+09', NULL, NULL, '2026-09-27 17:26:35.862926+09');
INSERT INTO public.outbox VALUES ('572087d6-7bdb-488d-a448-09ce1529ff13', 'tenant-a', 'embed', '{"memoryId": "a969f669-00e9-4797-9f48-34a1a6fc16b6"}', '2026-09-27 17:26:35.874196+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, '2026-09-27 17:26:36.074904+09', NULL, NULL, '2026-09-27 17:26:35.874196+09');
INSERT INTO public.outbox VALUES ('749b6575-050c-4d46-8a4f-f97fdbf5a7a5', 'tenant-a', 'embed', '{"memoryId": "1990b7cf-4b34-4127-bc05-2b57ca8e6204"}', '2026-09-27 17:26:35.886549+09', '2026-09-27 17:26:35.893+09', 'runtime.tick', 1, NULL, '2026-09-27 17:26:36.080049+09', 'fixture: embedding provider failure', '2026-09-27 17:26:35.886549+09');
INSERT INTO public.outbox VALUES ('d4c0b9c2-ab0e-4a33-80b6-3efda94cb61e', 'tenant-a', 'embed', '{"memoryId": "eb4c800b-4fcb-4ab7-9010-0c5becf8a23c"}', '2026-09-27 17:26:36.085105+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 17:26:36.085105+09');
INSERT INTO public.outbox VALUES ('fe67fce7-50c8-4f58-9dac-a87959e8e3db', 'tenant-a', 'extract', '{"observationId": "919b4f30-5a2b-4c09-a804-047a26f343bf"}', '2026-09-27 17:26:36.08143+09', NULL, NULL, 0, '2026-09-27 17:26:36.090757+09', NULL, NULL, '2026-09-27 17:26:36.08143+09');
INSERT INTO public.outbox VALUES ('baf820cd-ac19-4e57-93fd-6a3d97a18dca', 'tenant-a', 'embed', '{"memoryId": "11fbbb9d-e670-4358-a572-e39af12247ba"}', '2026-09-27 17:26:36.095401+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 17:26:36.095401+09');
INSERT INTO public.outbox VALUES ('8ee4d44c-f10d-4183-a773-636ae34a1876', 'tenant-a', 'extract', '{"observationId": "e466180c-70dc-4acc-9be0-6059048db745"}', '2026-09-27 17:26:36.091992+09', NULL, NULL, 0, '2026-09-27 17:26:36.100012+09', NULL, NULL, '2026-09-27 17:26:36.091992+09');
INSERT INTO public.outbox VALUES ('f4702dd0-3dce-4b84-aa1e-68bca1820fba', 'tenant-a', 'embed', '{"memoryId": "8fc143fc-d18b-4d3c-9dbf-592f5bdf9d93"}', '2026-09-27 17:26:36.104947+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 17:26:36.104947+09');
INSERT INTO public.outbox VALUES ('a381ce10-73d8-4d48-97c4-8ce55359e5d8', 'tenant-a', 'extract', '{"observationId": "a53c5203-b4e5-4ca6-9f75-418681c84dbd"}', '2026-09-27 17:26:36.101103+09', NULL, NULL, 0, '2026-09-27 17:26:36.109818+09', NULL, NULL, '2026-09-27 17:26:36.101103+09');
INSERT INTO public.outbox VALUES ('f9b98ddd-a5f9-4007-b617-0db89e6226de', 'tenant-b', 'extract', '{"observationId": "8081bf55-caa1-4b69-b5bb-084207cdc5d0"}', '2026-09-27 17:26:36.185463+09', NULL, NULL, 0, '2026-09-27 17:26:36.218846+09', NULL, NULL, '2026-09-27 17:26:36.185463+09');
INSERT INTO public.outbox VALUES ('534fddc8-2dc9-4317-9dec-0d4fe59bb038', 'tenant-b', 'extract', '{"observationId": "e48c0eeb-cc22-4516-a583-310f20b6e182"}', '2026-09-27 17:26:36.220075+09', NULL, NULL, 0, '2026-09-27 17:26:36.22701+09', NULL, NULL, '2026-09-27 17:26:36.220075+09');
INSERT INTO public.outbox VALUES ('12515485-fa9d-468d-bdcd-2fab6b4a751c', 'tenant-b', 'extract', '{"observationId": "1f83e39e-d6ec-458b-b505-461efa599f7f"}', '2026-09-27 17:26:36.228086+09', NULL, NULL, 0, '2026-09-27 17:26:36.236011+09', NULL, NULL, '2026-09-27 17:26:36.228086+09');
INSERT INTO public.outbox VALUES ('20f261de-0c98-4be8-948d-42d275daf26a', 'tenant-b', 'extract', '{"observationId": "c390fdb8-ce15-4ab0-8310-9b615e4a3dc9"}', '2026-09-27 17:26:36.237009+09', NULL, NULL, 0, '2026-09-27 17:26:36.243224+09', NULL, NULL, '2026-09-27 17:26:36.237009+09');
INSERT INTO public.outbox VALUES ('7e1fbc59-807a-4ac0-a514-6ed813357826', 'tenant-b', 'extract', '{"observationId": "09141171-b041-4047-9d5f-fe922042ff56"}', '2026-09-27 17:26:36.244333+09', NULL, NULL, 0, '2026-09-27 17:26:36.251936+09', NULL, NULL, '2026-09-27 17:26:36.244333+09');
INSERT INTO public.outbox VALUES ('22589faa-1664-48c3-8936-debc15410d7b', 'tenant-b', 'extract', '{"observationId": "d5a1552c-ae89-4403-8823-c2301b71c756"}', '2026-09-27 17:26:36.252822+09', NULL, NULL, 0, '2026-09-27 17:26:36.270459+09', NULL, NULL, '2026-09-27 17:26:36.252822+09');
INSERT INTO public.outbox VALUES ('5a4e61d9-d380-4f89-a31e-d1265c503a50', 'tenant-b', 'extract', '{"observationId": "76328bf5-29fe-4f88-9452-4c3eb3b7c47e"}', '2026-09-27 17:26:36.271916+09', NULL, NULL, 0, '2026-09-27 17:26:36.279807+09', NULL, NULL, '2026-09-27 17:26:36.271916+09');
INSERT INTO public.outbox VALUES ('d5f51d53-38dd-4c3e-ab3e-88ed7f5473a0', 'tenant-b', 'extract', '{"observationId": "a39f03aa-2a7e-4091-809f-3b358d5d4a37"}', '2026-09-27 17:26:36.280764+09', NULL, NULL, 0, '2026-09-27 17:26:36.287261+09', NULL, NULL, '2026-09-27 17:26:36.280764+09');
INSERT INTO public.outbox VALUES ('63c538d4-42fd-4da3-820f-4cd662200f52', 'tenant-b', 'embed', '{"memoryId": "c5033310-c878-4ba9-8794-43c0f5fb35e5"}', '2026-09-27 17:26:36.188686+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.390502+09', NULL, NULL, '2026-09-27 17:26:36.188686+09');
INSERT INTO public.outbox VALUES ('163465f1-5d6e-472a-94da-fd1b68d4a659', 'tenant-b', 'extract', '{"observationId": "bc582561-d81f-4324-8387-7edb335017a4"}', '2026-09-27 17:26:36.288179+09', NULL, NULL, 0, '2026-09-27 17:26:36.295622+09', NULL, NULL, '2026-09-27 17:26:36.288179+09');
INSERT INTO public.outbox VALUES ('a57afb4b-7ebf-4beb-8207-40255ca8de6d', 'tenant-b', 'extract', '{"observationId": "93c40601-7bad-4270-8a6e-2bf49b370ef8"}', '2026-09-27 17:26:36.296589+09', NULL, NULL, 0, '2026-09-27 17:26:36.303543+09', NULL, NULL, '2026-09-27 17:26:36.296589+09');
INSERT INTO public.outbox VALUES ('1bf279bc-a611-4b22-8c7a-5c2d841ab4a1', 'tenant-b', 'extract', '{"observationId": "34d110e2-5572-4fbc-943f-3af2161e9f34"}', '2026-09-27 17:26:36.30466+09', NULL, NULL, 0, '2026-09-27 17:26:36.311587+09', NULL, NULL, '2026-09-27 17:26:36.30466+09');
INSERT INTO public.outbox VALUES ('926a662c-8766-497b-b5d2-2f48001ed1ee', 'tenant-b', 'extract', '{"observationId": "b76d551b-d658-4a44-8c0c-f8feb6753277"}', '2026-09-27 17:26:36.312523+09', NULL, NULL, 0, '2026-09-27 17:26:36.319266+09', NULL, NULL, '2026-09-27 17:26:36.312523+09');
INSERT INTO public.outbox VALUES ('5a2ac938-224d-4725-ade1-480a3ca483b2', 'tenant-b', 'extract', '{"observationId": "8f287c02-9530-43eb-9ea0-2d552da1c655"}', '2026-09-27 17:26:36.320055+09', NULL, NULL, 0, '2026-09-27 17:26:36.324761+09', NULL, NULL, '2026-09-27 17:26:36.320055+09');
INSERT INTO public.outbox VALUES ('5ffbedbd-102f-4976-b063-1b32a3b17e26', 'tenant-b', 'extract', '{"observationId": "7be8c187-6ef0-484a-bd27-145347754c8b"}', '2026-09-27 17:26:36.325455+09', NULL, NULL, 0, '2026-09-27 17:26:36.34022+09', NULL, NULL, '2026-09-27 17:26:36.325455+09');
INSERT INTO public.outbox VALUES ('5174b92a-852a-4e11-b4e0-fe03188b5200', 'tenant-b', 'extract', '{"observationId": "aeff008b-66fa-46d9-8e1f-d50973fa7462"}', '2026-09-27 17:26:36.341689+09', NULL, NULL, 0, '2026-09-27 17:26:36.348294+09', NULL, NULL, '2026-09-27 17:26:36.341689+09');
INSERT INTO public.outbox VALUES ('eb1dab93-4f02-40cd-ae82-07fc0cd181e7', 'tenant-b', 'extract', '{"observationId": "ff7241b1-7fa2-4cd4-9ff8-b319435ecc97"}', '2026-09-27 17:26:36.349224+09', NULL, NULL, 0, '2026-09-27 17:26:36.355929+09', NULL, NULL, '2026-09-27 17:26:36.349224+09');
INSERT INTO public.outbox VALUES ('5a8ab265-9ad6-4e7c-99e1-647a19f4fcf6', 'tenant-b', 'extract', '{"observationId": "fb698135-7690-4c80-9787-87b733e2ffaf"}', '2026-09-27 17:26:36.356861+09', NULL, NULL, 0, '2026-09-27 17:26:36.364108+09', NULL, NULL, '2026-09-27 17:26:36.356861+09');
INSERT INTO public.outbox VALUES ('2f6d5dd9-bf22-42f0-b3da-ede1c231accc', 'tenant-b', 'extract', '{"observationId": "c2a0fcdf-0879-4b48-a587-12caae591b39"}', '2026-09-27 17:26:36.365163+09', NULL, NULL, 0, '2026-09-27 17:26:36.372349+09', NULL, NULL, '2026-09-27 17:26:36.365163+09');
INSERT INTO public.outbox VALUES ('212302ce-1f39-48e5-aebd-33262771d58d', 'tenant-b', 'extract', '{"observationId": "16faf11f-699f-4dd9-9c59-b90819d66069"}', '2026-09-27 17:26:36.373798+09', NULL, NULL, 0, '2026-09-27 17:26:36.382086+09', NULL, NULL, '2026-09-27 17:26:36.373798+09');
INSERT INTO public.outbox VALUES ('42a56d7a-f566-4dde-a51a-4594d666ef8e', 'tenant-b', 'embed', '{"memoryId": "f387983a-c837-441e-959b-c23f20ad8d66"}', '2026-09-27 17:26:36.223418+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.395697+09', NULL, NULL, '2026-09-27 17:26:36.223418+09');
INSERT INTO public.outbox VALUES ('4742a944-d4cd-4229-9959-56a439dc8b37', 'tenant-b', 'embed', '{"memoryId": "c3da3459-3ec9-4f3f-9888-fe229dca53ff"}', '2026-09-27 17:26:36.231497+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.401613+09', NULL, NULL, '2026-09-27 17:26:36.231497+09');
INSERT INTO public.outbox VALUES ('85804afc-b6f6-43da-8563-5d5c70f405e9', 'tenant-b', 'embed', '{"memoryId": "0f9c4e4e-e032-4b59-bf58-8823843b4e35"}', '2026-09-27 17:26:36.239839+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.4077+09', NULL, NULL, '2026-09-27 17:26:36.239839+09');
INSERT INTO public.outbox VALUES ('c75621c5-1fec-4f81-bcd4-caca8f08eca2', 'tenant-b', 'embed', '{"memoryId": "09092d23-aabc-4d1c-af04-6652a4895738"}', '2026-09-27 17:26:36.247993+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.412628+09', NULL, NULL, '2026-09-27 17:26:36.247993+09');
INSERT INTO public.outbox VALUES ('aea75f1e-c9df-40bf-ac1e-b6ed60a5db65', 'tenant-b', 'embed', '{"memoryId": "f1160e8a-c2f0-4577-b634-5a6479ffd228"}', '2026-09-27 17:26:36.255893+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.416755+09', NULL, NULL, '2026-09-27 17:26:36.255893+09');
INSERT INTO public.outbox VALUES ('543d7187-adb0-4f2c-83c4-dccdd779e5b1', 'tenant-b', 'embed', '{"memoryId": "29186798-1902-47d4-8c0b-9ff615a52b07"}', '2026-09-27 17:26:36.275814+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.421332+09', NULL, NULL, '2026-09-27 17:26:36.275814+09');
INSERT INTO public.outbox VALUES ('0f3af737-92b1-4dc3-8fb2-e7bdfac86b1b', 'tenant-b', 'embed', '{"memoryId": "e8702899-a403-49e2-affa-6113c6f4ac50"}', '2026-09-27 17:26:36.283525+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.425754+09', NULL, NULL, '2026-09-27 17:26:36.283525+09');
INSERT INTO public.outbox VALUES ('9c121072-ba8b-4cff-b215-afbdd80c0207', 'tenant-b', 'embed', '{"memoryId": "e1dfe4d9-6d5a-470d-8a6f-98374b0487a3"}', '2026-09-27 17:26:36.291636+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.430325+09', NULL, NULL, '2026-09-27 17:26:36.291636+09');
INSERT INTO public.outbox VALUES ('0e0e2f01-1695-4c3a-9f6a-d0cf589adb1d', 'tenant-b', 'embed', '{"memoryId": "8c3351de-f808-4dc4-98d7-c8185e9ed5fb"}', '2026-09-27 17:26:36.299955+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.437345+09', NULL, NULL, '2026-09-27 17:26:36.299955+09');
INSERT INTO public.outbox VALUES ('29cd2dde-57a0-43bb-b0a4-080789d6e72d', 'tenant-b', 'embed', '{"memoryId": "7ce0c761-95d5-449b-832c-f96e8c75e7f8"}', '2026-09-27 17:26:36.307819+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.443075+09', NULL, NULL, '2026-09-27 17:26:36.307819+09');
INSERT INTO public.outbox VALUES ('a001b8de-1573-4e08-95ac-7ea9f80ab001', 'tenant-b', 'embed', '{"memoryId": "01a3dad3-85e2-4ec4-983b-f89ccb781630"}', '2026-09-27 17:26:36.315734+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.449003+09', NULL, NULL, '2026-09-27 17:26:36.315734+09');
INSERT INTO public.outbox VALUES ('6de893d0-f536-4eac-9636-a4253e147d81', 'tenant-b', 'embed', '{"memoryId": "e857ce21-e916-415a-a351-8525f01fa2f2"}', '2026-09-27 17:26:36.322008+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.454339+09', NULL, NULL, '2026-09-27 17:26:36.322008+09');
INSERT INTO public.outbox VALUES ('dee74a32-c524-4a7e-83b0-14bf568bcace', 'tenant-b', 'embed', '{"memoryId": "06328de7-b40a-4e80-9628-49d3dd977ff5"}', '2026-09-27 17:26:36.328773+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.459898+09', NULL, NULL, '2026-09-27 17:26:36.328773+09');
INSERT INTO public.outbox VALUES ('bc83158c-ee70-4454-a2f0-db84f87c2802', 'tenant-b', 'embed', '{"memoryId": "113c85be-2a5c-4010-bc1d-7ec8474c262b"}', '2026-09-27 17:26:36.344996+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.466752+09', NULL, NULL, '2026-09-27 17:26:36.344996+09');
INSERT INTO public.outbox VALUES ('75cf9ecf-4735-41c1-a54a-038917c6054a', 'tenant-b', 'embed', '{"memoryId": "487c1ffc-1b58-4795-afc0-45d6dafdb200"}', '2026-09-27 17:26:36.352321+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.472901+09', NULL, NULL, '2026-09-27 17:26:36.352321+09');
INSERT INTO public.outbox VALUES ('aa2116ef-67c7-4b2d-9008-22151f9cb1d2', 'tenant-b', 'embed', '{"memoryId": "d1eb71b3-5dfa-4433-b45b-5b50f821a8af"}', '2026-09-27 17:26:36.359952+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.478575+09', NULL, NULL, '2026-09-27 17:26:36.359952+09');
INSERT INTO public.outbox VALUES ('be2d64f1-a492-4537-ada8-638d0434f229', 'tenant-b', 'embed', '{"memoryId": "c4fe7115-cb76-4111-8d41-74de41cc1199"}', '2026-09-27 17:26:36.367919+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, '2026-09-27 17:26:36.483854+09', NULL, NULL, '2026-09-27 17:26:36.367919+09');
INSERT INTO public.outbox VALUES ('02127d77-ec4e-4e20-bd1f-e34be66fcc1d', 'tenant-b', 'embed', '{"memoryId": "2c33c03c-2eb8-4608-8c05-1105ae1b6e9e"}', '2026-09-27 17:26:36.377576+09', '2026-09-27 17:26:36.382+09', 'runtime.tick', 1, NULL, '2026-09-27 17:26:36.487184+09', 'fixture: embedding provider failure', '2026-09-27 17:26:36.377576+09');
INSERT INTO public.outbox VALUES ('f21afeef-7018-4f2e-8639-3cb6fdc713dc', 'tenant-b', 'embed', '{"memoryId": "a06b4513-d95f-4536-a116-aa5ce2a02a5d"}', '2026-09-27 17:26:36.490842+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 17:26:36.490842+09');
INSERT INTO public.outbox VALUES ('c80883e4-3fcd-480e-b494-b646a6beb828', 'tenant-b', 'extract', '{"observationId": "1b56eb33-0cf9-4c14-a83b-86b6ead9ddef"}', '2026-09-27 17:26:36.488192+09', NULL, NULL, 0, '2026-09-27 17:26:36.494077+09', NULL, NULL, '2026-09-27 17:26:36.488192+09');
INSERT INTO public.outbox VALUES ('85d8d9a1-c448-4e61-970c-91cf39c44a0f', 'tenant-b', 'embed', '{"memoryId": "bc21c13f-dadc-4a44-9a4e-2e86c70ce3ec"}', '2026-09-27 17:26:36.498557+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 17:26:36.498557+09');
INSERT INTO public.outbox VALUES ('82b86b30-032e-4412-8278-23fc22226d41', 'tenant-b', 'extract', '{"observationId": "a307973c-b938-4b8a-873e-54e5b05b5d32"}', '2026-09-27 17:26:36.4951+09', NULL, NULL, 0, '2026-09-27 17:26:36.502493+09', NULL, NULL, '2026-09-27 17:26:36.4951+09');
INSERT INTO public.outbox VALUES ('93a1b25e-9fef-4e9d-8b9a-79bfc835588c', 'tenant-b', 'embed', '{"memoryId": "3d39dc08-75d2-4d73-8504-2b36abecb7bd"}', '2026-09-27 17:26:36.505061+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 17:26:36.505061+09');
INSERT INTO public.outbox VALUES ('37045ad3-cc90-439a-b785-75e6981cc5ad', 'tenant-b', 'extract', '{"observationId": "738de718-2b91-4989-b0b1-e5a2c91b8e11"}', '2026-09-27 17:26:36.503288+09', NULL, NULL, 0, '2026-09-27 17:26:36.509644+09', NULL, NULL, '2026-09-27 17:26:36.503288+09');
INSERT INTO public.outbox VALUES ('f21cb4f6-bb06-472d-b2ec-0f6cfe3d6cbb', 'tenant-c', 'extract', '{"observationId": "07f7c76f-ca1a-4a1a-bd40-290f824bc913"}', '2026-09-27 17:26:36.56284+09', NULL, NULL, 0, '2026-09-27 17:26:36.570307+09', NULL, NULL, '2026-09-27 17:26:36.56284+09');
INSERT INTO public.outbox VALUES ('8aa31481-166d-4bb7-be67-153eb396029e', 'tenant-c', 'extract', '{"observationId": "6513b15b-a19b-461f-b004-4b2f1c8b8236"}', '2026-09-27 17:26:36.571442+09', NULL, NULL, 0, '2026-09-27 17:26:36.579674+09', NULL, NULL, '2026-09-27 17:26:36.571442+09');
INSERT INTO public.outbox VALUES ('64d308e8-f84c-4117-b083-da36e06029a8', 'tenant-c', 'extract', '{"observationId": "ef20eac0-183a-441d-ae4c-d1208bbc60b9"}', '2026-09-27 17:26:36.58078+09', NULL, NULL, 0, '2026-09-27 17:26:36.587635+09', NULL, NULL, '2026-09-27 17:26:36.58078+09');
INSERT INTO public.outbox VALUES ('56b55a51-b528-4486-a354-c3774bcaa03f', 'tenant-c', 'extract', '{"observationId": "186851b6-5dab-4208-8a47-74679b18c535"}', '2026-09-27 17:26:36.588978+09', NULL, NULL, 0, '2026-09-27 17:26:36.597495+09', NULL, NULL, '2026-09-27 17:26:36.588978+09');
INSERT INTO public.outbox VALUES ('6d777c78-b2aa-452c-a254-8d19c91539e6', 'tenant-c', 'extract', '{"observationId": "f7b86ca3-c8dd-4685-8073-223c6ba4bdb9"}', '2026-09-27 17:26:36.598647+09', NULL, NULL, 0, '2026-09-27 17:26:36.607514+09', NULL, NULL, '2026-09-27 17:26:36.598647+09');
INSERT INTO public.outbox VALUES ('d32f2d12-3184-4573-9b3c-feff597dfbd8', 'tenant-c', 'extract', '{"observationId": "dca56308-506e-4890-acdf-80f1c0a56318"}', '2026-09-27 17:26:36.609493+09', NULL, NULL, 0, '2026-09-27 17:26:36.617118+09', NULL, NULL, '2026-09-27 17:26:36.609493+09');
INSERT INTO public.outbox VALUES ('7a273f34-226b-46f3-bb5e-e12aeb170d30', 'tenant-c', 'extract', '{"observationId": "17aff098-781c-4e5b-923e-47bea2eb80ad"}', '2026-09-27 17:26:36.618436+09', NULL, NULL, 0, '2026-09-27 17:26:36.625797+09', NULL, NULL, '2026-09-27 17:26:36.618436+09');
INSERT INTO public.outbox VALUES ('a78c2a72-b3cf-455e-abd1-d387040524f0', 'tenant-c', 'extract', '{"observationId": "85ee900e-3a10-4dc9-8589-61b94d7d0646"}', '2026-09-27 17:26:36.626971+09', NULL, NULL, 0, '2026-09-27 17:26:36.634687+09', NULL, NULL, '2026-09-27 17:26:36.626971+09');
INSERT INTO public.outbox VALUES ('fa9b6763-a875-46fc-9538-b301163f3164', 'tenant-c', 'extract', '{"observationId": "f29f1603-e28e-410a-a732-e9aab6e29fbe"}', '2026-09-27 17:26:36.635924+09', NULL, NULL, 0, '2026-09-27 17:26:36.646103+09', NULL, NULL, '2026-09-27 17:26:36.635924+09');
INSERT INTO public.outbox VALUES ('c3640154-cbee-4ff0-9cea-ffe031411ee9', 'tenant-c', 'extract', '{"observationId": "9ff6e3eb-de0b-4808-984b-a6b10babbcf7"}', '2026-09-27 17:26:36.647804+09', NULL, NULL, 0, '2026-09-27 17:26:36.656558+09', NULL, NULL, '2026-09-27 17:26:36.647804+09');
INSERT INTO public.outbox VALUES ('c0ab3cfb-0828-417b-9bb6-6ffed59240f2', 'tenant-c', 'extract', '{"observationId": "e223186b-7ebe-4bc6-ac71-5d1bd2834b0e"}', '2026-09-27 17:26:36.658081+09', NULL, NULL, 0, '2026-09-27 17:26:36.667129+09', NULL, NULL, '2026-09-27 17:26:36.658081+09');
INSERT INTO public.outbox VALUES ('a294fdcb-4303-4916-adfc-0c16a042a670', 'tenant-c', 'extract', '{"observationId": "ddcceee8-1683-4bb8-b75c-3c6b4fade0ca"}', '2026-09-27 17:26:36.668106+09', NULL, NULL, 0, '2026-09-27 17:26:36.675514+09', NULL, NULL, '2026-09-27 17:26:36.668106+09');
INSERT INTO public.outbox VALUES ('43f0409e-bd87-47a7-bd69-2809b89d854a', 'tenant-c', 'extract', '{"observationId": "a236e2c9-4422-420d-983f-7afb3ec2c0f7"}', '2026-09-27 17:26:36.676776+09', NULL, NULL, 0, '2026-09-27 17:26:36.684842+09', NULL, NULL, '2026-09-27 17:26:36.676776+09');
INSERT INTO public.outbox VALUES ('998b4136-898d-4adc-b41b-a2038a1f0de3', 'tenant-c', 'embed', '{"memoryId": "c7c688dc-642b-4b66-9d7a-625d7f166747"}', '2026-09-27 17:26:36.566389+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, '2026-09-27 17:26:36.693328+09', NULL, NULL, '2026-09-27 17:26:36.566389+09');
INSERT INTO public.outbox VALUES ('73eaa453-afc1-4840-b1db-bb98f60b5e73', 'tenant-c', 'embed', '{"memoryId": "ce0f3b70-1463-4ba7-aa80-0bebad9188bd"}', '2026-09-27 17:26:36.575249+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, '2026-09-27 17:26:36.701951+09', NULL, NULL, '2026-09-27 17:26:36.575249+09');
INSERT INTO public.outbox VALUES ('daef0593-0ae9-4e57-8b9f-2993648b8dd5', 'tenant-c', 'embed', '{"memoryId": "8bdb9539-6cee-4c87-b970-398670001e33"}', '2026-09-27 17:26:36.583485+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, '2026-09-27 17:26:36.709692+09', NULL, NULL, '2026-09-27 17:26:36.583485+09');
INSERT INTO public.outbox VALUES ('b40353f9-88ef-4e81-86d9-c0f979436879', 'tenant-c', 'embed', '{"memoryId": "1e8ced31-96c4-4001-bfb8-83fab2066475"}', '2026-09-27 17:26:36.59264+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, '2026-09-27 17:26:36.718179+09', NULL, NULL, '2026-09-27 17:26:36.59264+09');
INSERT INTO public.outbox VALUES ('78d12c1f-9164-4f88-9dd9-0e45e710a679', 'tenant-c', 'embed', '{"memoryId": "17973227-9578-4d24-a11e-ed82b1a18dfe"}', '2026-09-27 17:26:36.602452+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, '2026-09-27 17:26:36.72513+09', NULL, NULL, '2026-09-27 17:26:36.602452+09');
INSERT INTO public.outbox VALUES ('fa67e714-d893-4906-b458-d5fb0dcbdf01', 'tenant-c', 'embed', '{"memoryId": "773290c4-be30-41a2-bee6-97c76e908090"}', '2026-09-27 17:26:36.613422+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, '2026-09-27 17:26:36.731853+09', NULL, NULL, '2026-09-27 17:26:36.613422+09');
INSERT INTO public.outbox VALUES ('84f804bb-a1be-42b9-9f9e-84699a195282', 'tenant-c', 'embed', '{"memoryId": "176f8c3f-3d62-4bf3-8809-3632fa31b276"}', '2026-09-27 17:26:36.621953+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, '2026-09-27 17:26:36.737722+09', NULL, NULL, '2026-09-27 17:26:36.621953+09');
INSERT INTO public.outbox VALUES ('56c34e7d-3e36-455a-b976-3ff85b344794', 'tenant-c', 'embed', '{"memoryId": "7e362988-a627-4473-8a3c-207b893df777"}', '2026-09-27 17:26:36.630445+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, '2026-09-27 17:26:36.746228+09', NULL, NULL, '2026-09-27 17:26:36.630445+09');
INSERT INTO public.outbox VALUES ('7bb6075c-3e72-4396-8ed9-ab36930e1f37', 'tenant-c', 'embed', '{"memoryId": "e06636e2-bed7-489d-8e79-0fda31d3e677"}', '2026-09-27 17:26:36.63953+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, '2026-09-27 17:26:36.756071+09', NULL, NULL, '2026-09-27 17:26:36.63953+09');
INSERT INTO public.outbox VALUES ('9a0c4712-ba04-485f-b382-45a6298e528e', 'tenant-c', 'embed', '{"memoryId": "053401d5-8023-4bf4-b025-0286d4791c25"}', '2026-09-27 17:26:36.651558+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, '2026-09-27 17:26:36.768619+09', NULL, NULL, '2026-09-27 17:26:36.651558+09');
INSERT INTO public.outbox VALUES ('12043dc3-c9a9-472d-a924-251943ebf059', 'tenant-c', 'embed', '{"memoryId": "050dbf24-786a-457a-a9a1-db662bdaefce"}', '2026-09-27 17:26:36.661724+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, '2026-09-27 17:26:36.777855+09', NULL, NULL, '2026-09-27 17:26:36.661724+09');
INSERT INTO public.outbox VALUES ('564716fb-92a4-46cf-9c8b-d4bf69469d73', 'tenant-c', 'embed', '{"memoryId": "5ede7b84-a4b3-4e81-92cc-b60567016bc7"}', '2026-09-27 17:26:36.670954+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, '2026-09-27 17:26:36.786984+09', NULL, NULL, '2026-09-27 17:26:36.670954+09');
INSERT INTO public.outbox VALUES ('9ddd5361-bcee-4891-9a5f-1a89ef0ee9aa', 'tenant-c', 'embed', '{"memoryId": "12bc3c7c-49cd-4bdb-ac65-82d3d6b2a0f2"}', '2026-09-27 17:26:36.680398+09', '2026-09-27 17:26:36.685+09', 'runtime.tick', 1, NULL, '2026-09-27 17:26:36.79283+09', 'fixture: embedding provider failure', '2026-09-27 17:26:36.680398+09');
INSERT INTO public.outbox VALUES ('79cd0d91-3af8-45bf-89fd-21e564afae39', 'tenant-c', 'embed', '{"memoryId": "d917040d-a6b3-4dcc-8aac-1a822196a330"}', '2026-09-27 17:26:36.799006+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 17:26:36.799006+09');
INSERT INTO public.outbox VALUES ('f88fd514-5ff6-4c23-a231-26d4a326199f', 'tenant-c', 'extract', '{"observationId": "56869e20-27db-4d56-a4b8-b3a426bd4284"}', '2026-09-27 17:26:36.794739+09', NULL, NULL, 0, '2026-09-27 17:26:36.80551+09', NULL, NULL, '2026-09-27 17:26:36.794739+09');
INSERT INTO public.outbox VALUES ('70c4ba10-0eb8-4e5e-a137-d7bbfa62a507', 'tenant-c', 'embed', '{"memoryId": "5a2b10b7-567e-4ecb-9e23-ec177a527a23"}', '2026-09-27 17:26:36.811593+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 17:26:36.811593+09');
INSERT INTO public.outbox VALUES ('5d353d8b-ff54-4980-bf46-725bbdf6496e', 'tenant-c', 'extract', '{"observationId": "cbe892f1-2b9d-47ef-9adf-7a52a8a3811e"}', '2026-09-27 17:26:36.807084+09', NULL, NULL, 0, '2026-09-27 17:26:36.81662+09', NULL, NULL, '2026-09-27 17:26:36.807084+09');
INSERT INTO public.outbox VALUES ('b5c87896-d105-4db9-b0ec-2d40f222b861', 'tenant-c', 'embed', '{"memoryId": "6cb9bde5-b389-4f27-a21a-0b53b034518a"}', '2026-09-27 17:26:36.82162+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 17:26:36.82162+09');
INSERT INTO public.outbox VALUES ('18c1741a-9171-45db-8276-8a9eaa7d81ce', 'tenant-c', 'extract', '{"observationId": "79052058-3c32-4ec2-a1f0-bbe5cb83391b"}', '2026-09-27 17:26:36.817805+09', NULL, NULL, 0, '2026-09-27 17:26:36.826092+09', NULL, NULL, '2026-09-27 17:26:36.817805+09');
INSERT INTO public.outbox VALUES ('adf04b69-d1f9-4027-9de4-8c17d6a82db5', 'tenant-a2', 'extract', '{"observationId": "93f2966a-7d81-4b49-ab2f-7634d114abeb"}', '2026-09-27 17:26:36.900333+09', NULL, NULL, 0, '2026-09-27 17:26:36.908855+09', NULL, NULL, '2026-09-27 17:26:36.900333+09');
INSERT INTO public.outbox VALUES ('33267a2d-db7c-4b72-af13-458f209e0688', 'tenant-a2', 'extract', '{"observationId": "2820a427-c563-4e63-8a72-c7f1b3e4154c"}', '2026-09-27 17:26:36.910248+09', NULL, NULL, 0, '2026-09-27 17:26:36.917071+09', NULL, NULL, '2026-09-27 17:26:36.910248+09');
INSERT INTO public.outbox VALUES ('10d26152-6c80-4d23-a1a1-0bdea02ae3e3', 'tenant-a2', 'extract', '{"observationId": "0114a4fc-8137-4e7d-a259-88fd0db95813"}', '2026-09-27 17:26:36.91815+09', NULL, NULL, 0, '2026-09-27 17:26:36.925593+09', NULL, NULL, '2026-09-27 17:26:36.91815+09');
INSERT INTO public.outbox VALUES ('393c3eb9-e957-40ab-b844-34fde020e8cb', 'tenant-a2', 'extract', '{"observationId": "da2b795b-b8ef-46f6-bf4a-866df273bd97"}', '2026-09-27 17:26:36.926966+09', NULL, NULL, 0, '2026-09-27 17:26:36.933526+09', NULL, NULL, '2026-09-27 17:26:36.926966+09');
INSERT INTO public.outbox VALUES ('5e9502d1-2bd7-4e3d-bfbb-a72b2a7f155b', 'tenant-a2', 'embed', '{"memoryId": "c7284c02-1343-4909-9e9c-c121d9c9ed48"}', '2026-09-27 17:26:36.904082+09', '2026-09-27 17:26:37.006+09', 'runtime.tick', 1, '2026-09-27 17:26:37.013141+09', NULL, NULL, '2026-09-27 17:26:36.904082+09');
INSERT INTO public.outbox VALUES ('c1d03dad-2666-4283-9ca6-0cb7d797bcd7', 'tenant-a2', 'extract', '{"observationId": "14d5b8c8-208c-4ec8-92f4-5f9974d2c57d"}', '2026-09-27 17:26:36.934763+09', NULL, NULL, 0, '2026-09-27 17:26:36.942473+09', NULL, NULL, '2026-09-27 17:26:36.934763+09');
INSERT INTO public.outbox VALUES ('c35a1a93-e2cf-4045-8caf-9b2db05a8f02', 'tenant-a2', 'extract', '{"observationId": "5f1cd1ec-037a-47e7-8ad5-72745a7ac488"}', '2026-09-27 17:26:36.943532+09', NULL, NULL, 0, '2026-09-27 17:26:36.950919+09', NULL, NULL, '2026-09-27 17:26:36.943532+09');
INSERT INTO public.outbox VALUES ('08ca0f4a-82b0-4674-bfce-9689ed62b1b4', 'tenant-a2', 'extract', '{"observationId": "3647524f-a6ca-476f-ba99-224db9ecb6c0"}', '2026-09-27 17:26:36.952074+09', NULL, NULL, 0, '2026-09-27 17:26:36.95961+09', NULL, NULL, '2026-09-27 17:26:36.952074+09');
INSERT INTO public.outbox VALUES ('ca8f103a-458b-46c0-9561-b245813cb013', 'tenant-a2', 'extract', '{"observationId": "02642894-01b0-4f50-859d-115baeb9896e"}', '2026-09-27 17:26:36.96081+09', NULL, NULL, 0, '2026-09-27 17:26:36.975733+09', NULL, NULL, '2026-09-27 17:26:36.96081+09');
INSERT INTO public.outbox VALUES ('8356f9a9-f995-4550-b5f9-10177beb5402', 'tenant-a2', 'extract', '{"observationId": "a5d9a67a-bd0d-498c-aa4f-da735c6b6385"}', '2026-09-27 17:26:36.976818+09', NULL, NULL, 0, '2026-09-27 17:26:36.986459+09', NULL, NULL, '2026-09-27 17:26:36.976818+09');
INSERT INTO public.outbox VALUES ('561dea19-e189-472d-a699-4beb4a094ecc', 'tenant-a2', 'extract', '{"observationId": "96a41fc0-eccb-4484-a5eb-e8eb172b3b74"}', '2026-09-27 17:26:36.987895+09', NULL, NULL, 0, '2026-09-27 17:26:36.995559+09', NULL, NULL, '2026-09-27 17:26:36.987895+09');
INSERT INTO public.outbox VALUES ('b1b159f8-8014-40fd-b9a3-73636a3d0f7a', 'tenant-a2', 'extract', '{"observationId": "b330a75f-46af-4d2b-83b5-d81f6d19c162"}', '2026-09-27 17:26:36.996959+09', NULL, NULL, 0, '2026-09-27 17:26:37.005185+09', NULL, NULL, '2026-09-27 17:26:36.996959+09');
INSERT INTO public.outbox VALUES ('6415ca3a-5b8a-4932-823d-f34e43c3498c', 'tenant-a2', 'embed', '{"memoryId": "c001b1d2-cd88-41a7-9d1c-da1d52f8af89"}', '2026-09-27 17:26:36.913393+09', '2026-09-27 17:26:37.006+09', 'runtime.tick', 1, '2026-09-27 17:26:37.019768+09', NULL, NULL, '2026-09-27 17:26:36.913393+09');
INSERT INTO public.outbox VALUES ('fccad5ef-2edf-4be0-87e8-dd233da3fee0', 'tenant-a2', 'embed', '{"memoryId": "b2a88277-3dac-4fba-aae1-35a4921cdde3"}', '2026-09-27 17:26:36.921697+09', '2026-09-27 17:26:37.006+09', 'runtime.tick', 1, '2026-09-27 17:26:37.026154+09', NULL, NULL, '2026-09-27 17:26:36.921697+09');
INSERT INTO public.outbox VALUES ('313f3b65-6f11-4c08-ac0a-3f67658f9cde', 'tenant-a2', 'embed', '{"memoryId": "743d5edb-6f67-4fda-858b-611076d4641b"}', '2026-09-27 17:26:36.929496+09', '2026-09-27 17:26:37.006+09', 'runtime.tick', 1, '2026-09-27 17:26:37.032676+09', NULL, NULL, '2026-09-27 17:26:36.929496+09');
INSERT INTO public.outbox VALUES ('c2f10698-3201-416a-9407-b53271653b6f', 'tenant-a2', 'embed', '{"memoryId": "564e29cc-ca3d-479e-8e54-8e89fe2c3a8e"}', '2026-09-27 17:26:36.937857+09', '2026-09-27 17:26:37.006+09', 'runtime.tick', 1, '2026-09-27 17:26:37.039103+09', NULL, NULL, '2026-09-27 17:26:36.937857+09');
INSERT INTO public.outbox VALUES ('96561025-7d6b-4fd1-9e3d-a555631cfafa', 'tenant-a2', 'embed', '{"memoryId": "a65aa649-b580-47bb-bab4-081595b2bcc9"}', '2026-09-27 17:26:36.947055+09', '2026-09-27 17:26:37.006+09', 'runtime.tick', 1, '2026-09-27 17:26:37.045397+09', NULL, NULL, '2026-09-27 17:26:36.947055+09');
INSERT INTO public.outbox VALUES ('658c04ca-8ba1-4cde-bc74-f117a37874aa', 'tenant-a2', 'embed', '{"memoryId": "c1fc0bbc-6b41-484f-9f7a-cc60a61117d1"}', '2026-09-27 17:26:36.955107+09', '2026-09-27 17:26:37.006+09', 'runtime.tick', 1, '2026-09-27 17:26:37.050482+09', NULL, NULL, '2026-09-27 17:26:36.955107+09');
INSERT INTO public.outbox VALUES ('edef6862-dbcc-4fc6-bf50-eb2e738219bd', 'tenant-a2', 'embed', '{"memoryId": "d157ac3e-7765-46c4-9eda-63859fe6c725"}', '2026-09-27 17:26:36.970524+09', '2026-09-27 17:26:37.006+09', 'runtime.tick', 1, '2026-09-27 17:26:37.055929+09', NULL, NULL, '2026-09-27 17:26:36.970524+09');
INSERT INTO public.outbox VALUES ('4d0a054e-781c-4faa-ae3b-e7d55d3dd6d8', 'tenant-a2', 'embed', '{"memoryId": "1fb5aae5-93d0-499f-ac6b-d089d0e86c49"}', '2026-09-27 17:26:36.981233+09', '2026-09-27 17:26:37.006+09', 'runtime.tick', 1, '2026-09-27 17:26:37.061879+09', NULL, NULL, '2026-09-27 17:26:36.981233+09');
INSERT INTO public.outbox VALUES ('33d076e8-d367-4c11-af70-446cae90b8c1', 'tenant-a2', 'embed', '{"memoryId": "6f115c2d-8b9b-4a69-8a2a-4ab9e8f0e7b3"}', '2026-09-27 17:26:36.99086+09', '2026-09-27 17:26:37.006+09', 'runtime.tick', 1, '2026-09-27 17:26:37.068486+09', NULL, NULL, '2026-09-27 17:26:36.99086+09');
INSERT INTO public.outbox VALUES ('68e26b13-cdf0-4a83-8edd-fa81fb560f76', 'tenant-a2', 'embed', '{"memoryId": "724dd4fb-746a-4efb-87ac-cbcd1cdc0be1"}', '2026-09-27 17:26:37.000429+09', '2026-09-27 17:26:37.006+09', 'runtime.tick', 1, NULL, '2026-09-27 17:26:37.073185+09', 'fixture: embedding provider failure', '2026-09-27 17:26:37.000429+09');
INSERT INTO public.outbox VALUES ('48b28632-d749-47a1-ae4e-c3bfa4dcb00e', 'tenant-a2', 'embed', '{"memoryId": "599e874e-db44-4d71-8044-aebc72938e40"}', '2026-09-27 17:26:37.076696+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 17:26:37.076696+09');
INSERT INTO public.outbox VALUES ('58f1d79b-de3e-4ee1-ac66-cfd0836566cf', 'tenant-a2', 'extract', '{"observationId": "c9c061b1-19df-4773-9699-580c1771047d"}', '2026-09-27 17:26:37.074316+09', NULL, NULL, 0, '2026-09-27 17:26:37.081049+09', NULL, NULL, '2026-09-27 17:26:37.074316+09');
INSERT INTO public.outbox VALUES ('b0564bc4-999c-4994-b3af-62b877d58865', 'tenant-a2', 'embed', '{"memoryId": "e7585560-52f7-440d-ab25-82cf1e5d31e9"}', '2026-09-27 17:26:37.085398+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 17:26:37.085398+09');
INSERT INTO public.outbox VALUES ('d6909f35-4394-4b75-b621-4f4055fab36a', 'tenant-a2', 'extract', '{"observationId": "c7a2aec3-497e-4a25-a2df-a1ce9e70d7af"}', '2026-09-27 17:26:37.082293+09', NULL, NULL, 0, '2026-09-27 17:26:37.08945+09', NULL, NULL, '2026-09-27 17:26:37.082293+09');
INSERT INTO public.outbox VALUES ('c48779da-994e-4b2b-b2c8-cfdc086dec97', 'tenant-a2', 'embed', '{"memoryId": "153bfe51-2ed7-47c6-bd81-2474f0a6dd9f"}', '2026-09-27 17:26:37.093792+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 17:26:37.093792+09');
INSERT INTO public.outbox VALUES ('69c41955-168a-40af-90db-8f7e50e97986', 'tenant-a2', 'extract', '{"observationId": "1ffd5093-cc34-4385-89ca-8384ccdfd860"}', '2026-09-27 17:26:37.090738+09', NULL, NULL, 0, '2026-09-27 17:26:37.097261+09', NULL, NULL, '2026-09-27 17:26:37.090738+09');


--
-- Data for Name: recall_usages; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.recall_usages VALUES ('tenant-a', '4db76a55-011f-477a-a541-a8d3771e47bd', '6a49af7d-5d1b-4ef4-a1f8-464a557668c0', '2026-09-27 17:26:36.179787+09');
INSERT INTO public.recall_usages VALUES ('tenant-b', '2c6d13e3-7274-44fd-83f8-61f7b12b4bf2', '113c85be-2a5c-4010-bc1d-7ec8474c262b', '2026-09-27 17:26:36.558375+09');
INSERT INTO public.recall_usages VALUES ('tenant-c', '58f3b994-e023-40fa-ac18-8c70b3f6ab8b', '8bdb9539-6cee-4c87-b970-398670001e33', '2026-09-27 17:26:36.895644+09');
INSERT INTO public.recall_usages VALUES ('tenant-a2', 'e2e55b54-18a8-42b5-a15b-3841292fbe48', 'b2a88277-3dac-4fba-aae1-35a4921cdde3', '2026-09-27 17:26:37.149261+09');


--
-- Data for Name: recalls; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.recalls VALUES ('4db76a55-011f-477a-a541-a8d3771e47bd', 'tenant-a', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 2, "countKind": "exact"}, {"kind": "ann_truncated", "certainty": "undecidable", "countKind": "unknown", "undecidableReason": "ANN が返した最後の similarity が 0 以下または非有限である（NaN）。この場合、上界の不等式は total の順序を保証しない。"}, {"kind": "over_limit", "count": 2, "stage": "association", "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 2, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 1357, "byTier": {"full": 0, "index": 898, "digest": 459, "association": 286}, "counter": "heuristic", "indexChars": 898, "estimatedTokens": 527}', '{"groups": [{"key": null, "axis": "subject", "count": 24, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-a 未埋め込み 2", "memoryId": "8fc143fc-d18b-4d3c-9dbf-592f5bdf9d93"}, {"digest": "tenant-a 未埋め込み 1", "memoryId": "11fbbb9d-e670-4358-a572-e39af12247ba"}, {"digest": "tenant-a 未埋め込み 0", "memoryId": "eb4c800b-4fcb-4ab7-9010-0c5becf8a23c"}, {"digest": "tenant-a FAIL 埋め込み失敗 東京", "memoryId": "1990b7cf-4b34-4127-bc05-2b57ca8e6204"}, {"digest": "tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO", "memoryId": "83d44a87-2717-4941-9dca-cb04401c0f3a"}, {"digest": "tenant-a の記憶 7 東京 会議 プロジェクト2", "memoryId": "c0018122-60ce-4424-ad53-8f60715b9cbd"}, {"digest": "tenant-a の記憶 5 東京 会議 プロジェクト0", "memoryId": "f84da5fa-5216-4cac-9f7f-f1416c88669a"}, {"digest": "tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "937a0ddb-31e4-400c-bb04-602644bf0f29"}], "totalInScope": 24, "digestBandCoverage": {"shown": 8, "eligible": 8, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-09-27T08:26:36.144Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 20, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 20, "withinLimit": 5, "notComparable": 2, "passedThreshold": 18}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 0}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 15, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 24}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-27 17:26:36.165798+09', '{"memories": [{"score": {"decay": 0.999999920042053, "total": 0.7063610944898133, "strength": 1, "tagMatch": 1, "freshness": 0.999999920042053, "similarity": 0.7063612074481929, "affinityMeasured": true}, "memoryId": "6a49af7d-5d1b-4ef4-a1f8-464a557668c0", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999224488139, "total": 0.7058284436177473, "strength": 1, "tagMatch": 1, "freshness": 0.9999999224488139, "similarity": 0.7058285530934261, "affinityMeasured": true}, "memoryId": "b43cb04f-a124-4399-ba56-13035c654ac1", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999080082488, "total": 0.7057909509548964, "strength": 1, "tagMatch": 1, "freshness": 0.9999999080082488, "similarity": 0.7057910808088055, "affinityMeasured": true}, "memoryId": "18e03139-30b2-4af2-b2e6-0d716498ab9c", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999002531306, "total": 0.7056452994486674, "strength": 1, "tagMatch": 1, "freshness": 0.9999999002531306, "similarity": 0.7056454402205076, "affinityMeasured": true}, "memoryId": "328cd828-8369-4e71-9b7c-be834684f172", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999245881568, "total": 0.7052961811414892, "strength": 1, "tagMatch": 1, "freshness": 0.9999999245881568, "similarity": 0.7052962875168712, "affinityMeasured": true}, "memoryId": "c9cc58ac-32b7-4891-b5c0-8025884d8703", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999031947272, "total": 0.9999998063894637, "strength": 1, "tagMatch": 1, "freshness": 0.9999999031947272, "affinityMeasured": false}, "memoryId": "fd0091ab-fb3e-47ae-abdb-721f489eaa2c", "retrievedVia": "association", "associationOf": "6a49af7d-5d1b-4ef4-a1f8-464a557668c0"}, {"score": {"decay": 0.9999999275297534, "total": 0.999999855059512, "strength": 1, "tagMatch": 1, "freshness": 0.9999999275297534, "affinityMeasured": false}, "memoryId": "a969f669-00e9-4797-9f48-34a1a6fc16b6", "retrievedVia": "association", "associationOf": "6a49af7d-5d1b-4ef4-a1f8-464a557668c0"}, {"score": {"decay": 0.9999999058689059, "total": 0.9999998117378206, "strength": 1, "tagMatch": 1, "freshness": 0.9999999058689059, "affinityMeasured": false}, "memoryId": "320440dd-9312-45b2-9d54-40f967e9284d", "retrievedVia": "association", "associationOf": "6a49af7d-5d1b-4ef4-a1f8-464a557668c0"}, {"score": {"decay": 0.9999999101475917, "total": 0.9999998202951915, "strength": 1, "tagMatch": 1, "freshness": 0.9999999101475917, "affinityMeasured": false}, "memoryId": "c7cc1eab-71b0-4171-b1cd-dd2e45f437b3", "retrievedVia": "association", "associationOf": "6a49af7d-5d1b-4ef4-a1f8-464a557668c0"}, {"score": {"decay": 0.9999999149611134, "total": 0.999999829922234, "strength": 1, "tagMatch": 1, "freshness": 0.9999999149611134, "affinityMeasured": false}, "memoryId": "891e6d25-c61b-4e89-ab22-3cbb648d5bbb", "retrievedVia": "association", "associationOf": "6a49af7d-5d1b-4ef4-a1f8-464a557668c0"}, {"score": {"decay": 0.9999999176352922, "total": 0.9999998352705911, "strength": 1, "tagMatch": 1, "freshness": 0.9999999176352922, "affinityMeasured": false}, "memoryId": "73c39b8f-033e-490a-89e4-e8462dd18fc8", "retrievedVia": "association", "associationOf": "6a49af7d-5d1b-4ef4-a1f8-464a557668c0"}, {"score": {"decay": 0.9999998676281514, "total": 0.9999997352563204, "strength": 1, "tagMatch": 1, "freshness": 0.9999998676281514, "affinityMeasured": false}, "memoryId": "37bcb397-24bd-48ac-a58b-dcef8f8b7661", "retrievedVia": "association", "associationOf": "6a49af7d-5d1b-4ef4-a1f8-464a557668c0"}, {"score": {"decay": 0.9999998649539728, "total": 0.9999997299079637, "strength": 1, "tagMatch": 1, "freshness": 0.9999998649539728, "affinityMeasured": false}, "memoryId": "315c766c-88ec-4aec-879e-46becac0e106", "retrievedVia": "association", "associationOf": "6a49af7d-5d1b-4ef4-a1f8-464a557668c0"}, {"score": {"decay": 0.9999998596056157, "total": 0.9999997192112511, "strength": 1, "tagMatch": 1, "freshness": 0.9999998596056157, "affinityMeasured": false}, "memoryId": "603bd1d7-ad6e-4be4-950e-26058d1e381a", "retrievedVia": "association", "associationOf": "6a49af7d-5d1b-4ef4-a1f8-464a557668c0"}, {"score": {"decay": 0.9999998876844909, "total": 0.9999997753689944, "strength": 1, "tagMatch": 1, "freshness": 0.9999998876844909, "affinityMeasured": false}, "memoryId": "d51c9734-c69a-4b73-8477-1ebfdf639af2", "retrievedVia": "association", "associationOf": "6a49af7d-5d1b-4ef4-a1f8-464a557668c0"}, {"score": {"decay": 0.9999998809990444, "total": 0.9999997619981029, "strength": 1, "tagMatch": 1, "freshness": 0.9999998809990444, "affinityMeasured": false}, "memoryId": "531faf45-6027-4cb6-ae98-ad649a330750", "companionOf": "d51c9734-c69a-4b73-8477-1ebfdf639af2", "retrievedVia": "mandatory_companion"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('2c6d13e3-7274-44fd-83f8-61f7b12b4bf2', 'tenant-b', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 2, "countKind": "exact"}, {"kind": "unit_assembly_dropped", "count": 1, "countKind": "lower_bound"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 3, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 1091, "byTier": {"full": 0, "index": 806, "digest": 285, "association": 140}, "counter": "heuristic", "indexChars": 806, "estimatedTokens": 400}', '{"groups": [{"key": null, "axis": "subject", "count": 17, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-b 未埋め込み 2", "memoryId": "3d39dc08-75d2-4d73-8504-2b36abecb7bd"}, {"digest": "tenant-b 未埋め込み 1", "memoryId": "bc21c13f-dadc-4a44-9a4e-2e86c70ce3ec"}, {"digest": "tenant-b 未埋め込み 0", "memoryId": "a06b4513-d95f-4536-a116-aa5ce2a02a5d"}, {"digest": "tenant-b FAIL 埋め込み失敗 東京", "memoryId": "2c33c03c-2eb8-4608-8c05-1105ae1b6e9e"}, {"digest": "tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO", "memoryId": "c4fe7115-cb76-4111-8d41-74de41cc1199"}, {"digest": "tenant-b の記憶 6 東京 会議 プロジェクト1", "memoryId": "29186798-1902-47d4-8c0b-9ff615a52b07"}, {"digest": "tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "0f9c4e4e-e032-4b59-bf58-8823843b4e35"}], "totalInScope": 17, "digestBandCoverage": {"shown": 7, "eligible": 7, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-09-27T08:26:36.537Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 13, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 13, "withinLimit": 5, "notComparable": 2, "passedThreshold": 11}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 0}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 10, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 17}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-27 17:26:36.552443+09', '{"memories": [{"score": {"decay": 0.9999999483883478, "total": 0.6564809739963358, "strength": 1, "tagMatch": 1, "freshness": 0.9999999483883478, "similarity": 0.6564810417604764, "affinityMeasured": true}, "memoryId": "113c85be-2a5c-4010-bc1d-7ec8474c262b", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999441096618, "total": 0.6564712002237082, "strength": 1, "tagMatch": 1, "freshness": 0.9999999441096618, "similarity": 0.6564712736045092, "affinityMeasured": true}, "memoryId": "06328de7-b40a-4e80-9628-49d3dd977ff5", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999422377366, "total": 0.6564611907843121, "strength": 1, "tagMatch": 1, "freshness": 0.9999999422377366, "similarity": 0.6564612666216871, "affinityMeasured": true}, "memoryId": "e857ce21-e916-415a-a351-8525f01fa2f2", "retrievedVia": "ann"}, {"score": {"decay": 0.999999952399616, "total": 0.6554165561082019, "strength": 1, "tagMatch": 1, "freshness": 0.999999952399616, "similarity": 0.6554166185043658, "affinityMeasured": true}, "memoryId": "d1eb71b3-5dfa-4433-b45b-5b50f821a8af", "retrievedVia": "ann"}, {"score": {"decay": 0.999999950260273, "total": 0.6554060395228054, "strength": 1, "tagMatch": 1, "freshness": 0.999999950260273, "similarity": 0.6554061047222453, "affinityMeasured": true}, "memoryId": "487c1ffc-1b58-4795-afc0-45d6dafdb200", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999066711595, "total": 0.9999998133423276, "strength": 1, "tagMatch": 1, "freshness": 0.9999999066711595, "affinityMeasured": false}, "memoryId": "c5033310-c878-4ba9-8794-43c0f5fb35e5", "retrievedVia": "association", "associationOf": "113c85be-2a5c-4010-bc1d-7ec8474c262b"}, {"score": {"decay": 0.999999915763367, "total": 0.9999998315267411, "strength": 1, "tagMatch": 1, "freshness": 0.999999915763367, "affinityMeasured": false}, "memoryId": "f387983a-c837-441e-959b-c23f20ad8d66", "retrievedVia": "association", "associationOf": "113c85be-2a5c-4010-bc1d-7ec8474c262b"}, {"score": {"decay": 0.99999991790271, "total": 0.9999998358054268, "strength": 1, "tagMatch": 1, "freshness": 0.99999991790271, "affinityMeasured": false}, "memoryId": "c3da3459-3ec9-4f3f-9888-fe229dca53ff", "retrievedVia": "association", "associationOf": "113c85be-2a5c-4010-bc1d-7ec8474c262b"}, {"score": {"decay": 0.9999999245881568, "total": 0.9999998491763192, "strength": 1, "tagMatch": 1, "freshness": 0.9999999245881568, "affinityMeasured": false}, "memoryId": "f1160e8a-c2f0-4577-b634-5a6479ffd228", "retrievedVia": "association", "associationOf": "113c85be-2a5c-4010-bc1d-7ec8474c262b"}, {"score": {"decay": 0.9999999318084394, "total": 0.9999998636168834, "strength": 1, "tagMatch": 1, "freshness": 0.9999999318084394, "affinityMeasured": false}, "memoryId": "e8702899-a403-49e2-affa-6113c6f4ac50", "retrievedVia": "association", "associationOf": "113c85be-2a5c-4010-bc1d-7ec8474c262b"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('58f3b994-e023-40fa-ac18-8c70b3f6ab8b', 'tenant-c', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 1, "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 3, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 784, "byTier": {"full": 0, "index": 616, "digest": 168, "association": 0}, "counter": "heuristic", "indexChars": 616, "estimatedTokens": 272}', '{"groups": [{"key": null, "axis": "subject", "count": 11, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-c 未埋め込み 2", "memoryId": "6cb9bde5-b389-4f27-a21a-0b53b034518a"}, {"digest": "tenant-c 未埋め込み 1", "memoryId": "5a2b10b7-567e-4ecb-9e23-ec177a527a23"}, {"digest": "tenant-c 未埋め込み 0", "memoryId": "d917040d-a6b3-4dcc-8aac-1a822196a330"}, {"digest": "tenant-c FAIL 埋め込み失敗 東京", "memoryId": "12bc3c7c-49cd-4bdb-ac65-82d3d6b2a0f2"}, {"digest": "tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "1e8ced31-96c4-4001-bfb8-83fab2066475"}], "totalInScope": 11, "digestBandCoverage": {"shown": 5, "eligible": 5, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-09-27T08:26:36.868Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 7, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 7, "withinLimit": 5, "notComparable": 1, "passedThreshold": 6}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 1}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 5, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 11}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-27 17:26:36.891763+09', '{"memories": [{"score": {"decay": 0.9999999235184853, "total": 0.5446698612634756, "strength": 1, "tagMatch": 1, "freshness": 0.9999999235184853, "similarity": 0.5446699445778371, "affinityMeasured": true}, "memoryId": "8bdb9539-6cee-4c87-b970-398670001e33", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999213791423, "total": 0.5442745076507832, "strength": 1, "tagMatch": 1, "freshness": 0.9999999213791423, "similarity": 0.5442745932334506, "affinityMeasured": true}, "memoryId": "ce0f3b70-1463-4ba7-aa80-0bebad9188bd", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999384938864, "total": 0.5442010508297245, "strength": 1, "tagMatch": 1, "freshness": 0.9999999384938864, "similarity": 0.544201117773114, "affinityMeasured": true}, "memoryId": "e06636e2-bed7-489d-8e79-0fda31d3e677", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999339477824, "total": 0.9999998678955692, "strength": 1, "tagMatch": 1, "freshness": 0.9999999339477824, "affinityMeasured": false}, "memoryId": "176f8c3f-3d62-4bf3-8809-3632fa31b276", "companionOf": "e06636e2-bed7-489d-8e79-0fda31d3e677", "retrievedVia": "mandatory_companion"}, {"score": {"decay": 0.9999999189723815, "total": 0.5438775189085153, "strength": 1, "tagMatch": 1, "freshness": 0.9999999189723815, "similarity": 0.5438776070467263, "affinityMeasured": true}, "memoryId": "c7c688dc-642b-4b66-9d7a-625d7f166747", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999360871255, "total": 0.543807615408134, "strength": 1, "tagMatch": 1, "freshness": 0.9999999360871255, "similarity": 0.5438076849207566, "affinityMeasured": true}, "memoryId": "7e362988-a627-4473-8a3c-207b893df777", "retrievedVia": "ann"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('e2e55b54-18a8-42b5-a15b-3841292fbe48', 'tenant-a2', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 1, "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 2, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 662, "byTier": {"full": 0, "index": 459, "digest": 203, "association": 29}, "counter": "heuristic", "indexChars": 459, "estimatedTokens": 244}', '{"groups": [{"key": null, "axis": "subject", "count": 10, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-a2 未埋め込み 2", "memoryId": "153bfe51-2ed7-47c6-bd81-2474f0a6dd9f"}, {"digest": "tenant-a2 FAIL 埋め込み失敗 東京", "memoryId": "724dd4fb-746a-4efb-87ac-cbcd1cdc0be1"}, {"digest": "tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "743d5edb-6f67-4fda-858b-611076d4641b"}], "totalInScope": 10, "digestBandCoverage": {"shown": 3, "eligible": 3, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-09-27T08:26:37.121Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 8, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 8, "withinLimit": 5, "notComparable": 1, "passedThreshold": 7}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 1}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 6, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 10}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-27 17:26:37.142023+09', '{"memories": [{"score": {"decay": 0.9999999465164227, "total": 0.3296480511899131, "strength": 1, "tagMatch": 1, "freshness": 0.9999999465164227, "similarity": 0.32964808645142996, "affinityMeasured": true}, "memoryId": "b2a88277-3dac-4fba-aae1-35a4921cdde3", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999622940777, "total": 0.3295125115614614, "strength": 1, "tagMatch": 1, "freshness": 0.9999999622940777, "similarity": 0.32951253641060907, "affinityMeasured": true}, "memoryId": "1fb5aae5-93d0-499f-ac6b-d089d0e86c49", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999553412128, "total": 0.9999999106824276, "strength": 1, "tagMatch": 1, "freshness": 0.9999999553412128, "affinityMeasured": false}, "memoryId": "c1fc0bbc-6b41-484f-9f7a-cc60a61117d1", "companionOf": "1fb5aae5-93d0-499f-ac6b-d089d0e86c49", "retrievedVia": "mandatory_companion"}, {"score": {"decay": 0.9999999441096618, "total": 0.32920261447295085, "strength": 1, "tagMatch": 1, "freshness": 0.9999999441096618, "similarity": 0.3292026512714449, "affinityMeasured": true}, "memoryId": "c001b1d2-cd88-41a7-9d1c-da1d52f8af89", "retrievedVia": "ann"}, {"score": {"decay": 0.999999959352481, "total": 0.3290689793399307, "strength": 1, "tagMatch": 1, "freshness": 0.999999959352481, "similarity": 0.3290690060916075, "affinityMeasured": true}, "memoryId": "d157ac3e-7765-46c4-9eda-63859fe6c725", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999417029009, "total": 0.3287565222488331, "strength": 1, "tagMatch": 1, "freshness": 0.9999999417029009, "similarity": 0.3287565605799396, "affinityMeasured": true}, "memoryId": "c7284c02-1343-4909-9e9c-c121d9c9ed48", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999532018697, "total": 0.9999999064037417, "strength": 1, "tagMatch": 1, "freshness": 0.9999999532018697, "affinityMeasured": false}, "memoryId": "a65aa649-b580-47bb-bab4-081595b2bcc9", "retrievedVia": "association", "associationOf": "b2a88277-3dac-4fba-aae1-35a4921cdde3"}], "breakdownCaptured": true}');


--
-- Data for Name: tenant_activity; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: tenant_settings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: _mnemora_migrations _mnemora_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._mnemora_migrations
    ADD CONSTRAINT _mnemora_migrations_pkey PRIMARY KEY (name);


--
-- Name: labels labels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labels
    ADD CONSTRAINT labels_pkey PRIMARY KEY (id);


--
-- Name: labels labels_tenant_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labels
    ADD CONSTRAINT labels_tenant_id_name_key UNIQUE (tenant_id, name);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 memory_embeddings_some_very_long_provider_name_an_extr_b34_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257
    ADD CONSTRAINT memory_embeddings_some_very_long_provider_name_an_extr_b34_pkey PRIMARY KEY (tenant_id, memory_id);


--
-- Name: memory_embeddings_test_fixture_model_3 memory_embeddings_test_fixture_model_3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_test_fixture_model_3
    ADD CONSTRAINT memory_embeddings_test_fixture_model_3_pkey PRIMARY KEY (tenant_id, memory_id);


--
-- Name: memory_embeddings_testkit_deterministic_8 memory_embeddings_testkit_deterministic_8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_testkit_deterministic_8
    ADD CONSTRAINT memory_embeddings_testkit_deterministic_8_pkey PRIMARY KEY (tenant_id, memory_id);


--
-- Name: memory_events memory_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_events
    ADD CONSTRAINT memory_events_pkey PRIMARY KEY (id);


--
-- Name: memory_labels memory_labels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_labels
    ADD CONSTRAINT memory_labels_pkey PRIMARY KEY (tenant_id, memory_id, label_id);


--
-- Name: observations observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: recall_usages recall_usages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_usages
    ADD CONSTRAINT recall_usages_pkey PRIMARY KEY (tenant_id, recall_id, memory_id);


--
-- Name: recalls recalls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_pkey PRIMARY KEY (id);


--
-- Name: tenant_activity tenant_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_activity
    ADD CONSTRAINT tenant_activity_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_settings tenant_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_pkey PRIMARY KEY (tenant_id);


--
-- Name: idx_labels_by_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_labels_by_status ON public.labels USING btree (tenant_id, status);


--
-- Name: idx_memories_attributes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_attributes ON public.memories USING gin (tenant_id, attributes jsonb_path_ops);


--
-- Name: idx_memories_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_by_subject ON public.memories USING btree (tenant_id, subject_id, status);


--
-- Name: idx_memories_claim_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_claim_key ON public.memories USING btree (tenant_id, subject_id, claim_key_subject, claim_key_predicate) WHERE (claim_key_subject IS NOT NULL);


--
-- Name: idx_memories_contested; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_contested ON public.memories USING btree (tenant_id, status) WHERE (status = 'contested'::text);


--
-- Name: idx_memories_contested_with; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_contested_with ON public.memories USING btree (contested_with_id) WHERE (contested_with_id IS NOT NULL);


--
-- Name: idx_memories_lexical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_lexical ON public.memories USING gin (tenant_id, to_tsvector('simple'::regconfig, public.mnemora_lexical_normalize(content))) WHERE (status = ANY (ARRAY['active'::text, 'contested'::text]));


--
-- Name: idx_memories_period_ann_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_period_ann_stage ON public.memories USING btree (tenant_id, status, COALESCE(occurred_at, recorded_at));


--
-- Name: idx_memories_provenance_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_provenance_kind ON public.memories USING btree (tenant_id, provenance_kind);


--
-- Name: idx_memories_recall_gate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_recall_gate ON public.memories USING btree (tenant_id, status, decay_floor_at) WHERE (status = ANY (ARRAY['active'::text, 'contested'::text]));


--
-- Name: idx_memories_recall_gate_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_recall_gate_seq ON public.memories USING btree (tenant_id, status, decay_floor_seq) WHERE (status = ANY (ARRAY['active'::text, 'contested'::text]));


--
-- Name: idx_memories_requeue_embed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_requeue_embed ON public.memories USING btree (tenant_id, updated_at, id) WHERE ((status = ANY (ARRAY['active'::text, 'contested'::text])) AND (embedding_status <> 'ready'::text));


--
-- Name: idx_memories_superseded_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_superseded_by ON public.memories USING btree (tenant_id, superseded_by_id) WHERE (superseded_by_id IS NOT NULL);


--
-- Name: idx_memories_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_tags ON public.memories USING gin (tenant_id, tags);


--
-- Name: idx_memory_embeddings_hnsw_some_very_long_provider_nam_0428309b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_hnsw_some_very_long_provider_nam_0428309b ON public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_memory_embeddings_hnsw_test_fixture_model_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_hnsw_test_fixture_model_3 ON public.memory_embeddings_test_fixture_model_3 USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_memory_embeddings_hnsw_testkit_deterministic_8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_hnsw_testkit_deterministic_8 ON public.memory_embeddings_testkit_deterministic_8 USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_memory_embeddings_zero_norm_some_very_long_provide_0428309b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_zero_norm_some_very_long_provide_0428309b ON public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 USING btree (tenant_id, memory_id) WHERE (public.vector_norm(embedding) = (0)::double precision);


--
-- Name: idx_memory_embeddings_zero_norm_test_fixture_model_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_zero_norm_test_fixture_model_3 ON public.memory_embeddings_test_fixture_model_3 USING btree (tenant_id, memory_id) WHERE (public.vector_norm(embedding) = (0)::double precision);


--
-- Name: idx_memory_embeddings_zero_norm_testkit_deterministic_8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_zero_norm_testkit_deterministic_8 ON public.memory_embeddings_testkit_deterministic_8 USING btree (tenant_id, memory_id) WHERE (public.vector_norm(embedding) = (0)::double precision);


--
-- Name: idx_memory_events_by_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_by_kind ON public.memory_events USING btree (tenant_id, kind, at);


--
-- Name: idx_memory_events_by_memory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_by_memory ON public.memory_events USING btree (tenant_id, memory_id, at);


--
-- Name: idx_memory_events_by_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_by_retention ON public.memory_events USING btree (tenant_id, at);


--
-- Name: idx_memory_labels_by_label; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_labels_by_label ON public.memory_labels USING btree (tenant_id, label_id);


--
-- Name: idx_observations_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_observations_by_subject ON public.observations USING btree (tenant_id, subject_id, recorded_at);


--
-- Name: idx_outbox_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_claimable ON public.outbox USING btree (tenant_id, available_at) WHERE ((completed_at IS NULL) AND (failed_at IS NULL));


--
-- Name: idx_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_pending ON public.outbox USING btree (tenant_id, kind, available_at) WHERE ((completed_at IS NULL) AND (claimed_at IS NULL));


--
-- Name: idx_recalls_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recalls_by_subject ON public.recalls USING btree (tenant_id, subject_id, created_at);


--
-- Name: uq_memories_extraction; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_memories_extraction ON public.memories USING btree (tenant_id, source_observation_id, extractor_version, content_hash) NULLS NOT DISTINCT WHERE (source_observation_id IS NOT NULL);


--
-- Name: uq_observations_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_observations_external_id ON public.observations USING btree (tenant_id, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: memories memories_contested_with_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_contested_with_id_fkey FOREIGN KEY (contested_with_id) REFERENCES public.memories(id);


--
-- Name: memories memories_source_observation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_source_observation_id_fkey FOREIGN KEY (source_observation_id) REFERENCES public.observations(id);


--
-- Name: memories memories_superseded_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_superseded_by_id_fkey FOREIGN KEY (superseded_by_id) REFERENCES public.memories(id);


--
-- Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 memory_embeddings_some_very_long_provider_name_a_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257
    ADD CONSTRAINT memory_embeddings_some_very_long_provider_name_a_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_embeddings_test_fixture_model_3 memory_embeddings_test_fixture_model_3_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_test_fixture_model_3
    ADD CONSTRAINT memory_embeddings_test_fixture_model_3_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_embeddings_testkit_deterministic_8 memory_embeddings_testkit_deterministic_8_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_testkit_deterministic_8
    ADD CONSTRAINT memory_embeddings_testkit_deterministic_8_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_events memory_events_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_events
    ADD CONSTRAINT memory_events_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id);


--
-- Name: memory_labels memory_labels_label_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_labels
    ADD CONSTRAINT memory_labels_label_id_fkey FOREIGN KEY (label_id) REFERENCES public.labels(id);


--
-- Name: memory_labels memory_labels_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_labels
    ADD CONSTRAINT memory_labels_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id);


--
-- Name: recall_usages recall_usages_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_usages
    ADD CONSTRAINT recall_usages_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id);


--
-- Name: recall_usages recall_usages_recall_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_usages
    ADD CONSTRAINT recall_usages_recall_id_fkey FOREIGN KEY (recall_id) REFERENCES public.recalls(id);


--
-- PostgreSQL database dump complete
--


