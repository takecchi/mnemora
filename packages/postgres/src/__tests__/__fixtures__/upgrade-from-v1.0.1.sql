-- 公開済みの版 v1.0.1 で作った DB の fixture（ADR 0344）。
-- ⛔ 手で編集しない。作り直すときは scripts/generate-upgrade-fixture.mjs を走らせる。
--
-- 作ったコード: v1.0.1（cf11cd6346894496aac88e3e1ff9072f4ee3b7d4）の @mnemora/postgres / @mnemora/core / @mnemora/testkit。
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

INSERT INTO public._mnemora_migrations VALUES ('0001_init.sql', '2026-09-27 06:47:03.647222+09');
INSERT INTO public._mnemora_migrations VALUES ('0002_outbox_claim_lease_index.sql', '2026-09-27 06:47:03.668422+09');
INSERT INTO public._mnemora_migrations VALUES ('0003_period_ann_stage_index.sql', '2026-09-27 06:47:03.671182+09');
INSERT INTO public._mnemora_migrations VALUES ('0004_contested_with_index.sql', '2026-09-27 06:47:03.674379+09');
INSERT INTO public._mnemora_migrations VALUES ('0005_analyze_memories.sql', '2026-09-27 06:47:03.676298+09');
INSERT INTO public._mnemora_migrations VALUES ('0006_strength_value_range.sql', '2026-09-27 06:47:03.678844+09');
INSERT INTO public._mnemora_migrations VALUES ('0007_memories_requeue_embed_index.sql', '2026-09-27 06:47:03.681052+09');
INSERT INTO public._mnemora_migrations VALUES ('0008_memories_lexical_index.sql', '2026-09-27 06:47:03.683239+09');
INSERT INTO public._mnemora_migrations VALUES ('0009_memories_lexical_or_coverage.sql', '2026-09-27 06:47:03.706329+09');
INSERT INTO public._mnemora_migrations VALUES ('0010_memory_events_retention_index.sql', '2026-09-27 06:47:03.709495+09');
INSERT INTO public._mnemora_migrations VALUES ('0011_memory_events_kind_restored.sql', '2026-09-27 06:47:03.711587+09');
INSERT INTO public._mnemora_migrations VALUES ('0012_half_life_hours_range.sql', '2026-09-27 06:47:03.716642+09');
INSERT INTO public._mnemora_migrations VALUES ('0013_recall_returned_memories_jsonb.sql', '2026-09-27 06:47:03.719841+09');
INSERT INTO public._mnemora_migrations VALUES ('0014_observations_valid_from_until.sql', '2026-09-27 06:47:03.723892+09');
INSERT INTO public._mnemora_migrations VALUES ('0015_decay_activity_clock.sql', '2026-09-27 06:47:03.726064+09');
INSERT INTO public._mnemora_migrations VALUES ('0016_provenance_kind_matches_provenance.sql', '2026-09-27 06:47:03.731755+09');
INSERT INTO public._mnemora_migrations VALUES ('0017_provenance_kind_matches_provenance_validate.sql', '2026-09-27 06:47:03.733339+09');
INSERT INTO public._mnemora_migrations VALUES ('0018_memory_events_kind_unsuperseded.sql', '2026-09-27 06:47:03.73437+09');
INSERT INTO public._mnemora_migrations VALUES ('0019_observations_memories_attributes.sql', '2026-09-27 06:47:03.736324+09');
INSERT INTO public._mnemora_migrations VALUES ('0020_taxonomy_labels.sql', '2026-09-27 06:47:03.738403+09');
INSERT INTO public._mnemora_migrations VALUES ('0021_memories_claim_key.sql', '2026-09-27 06:47:03.761976+09');


--
-- Data for Name: labels; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: memories; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memories VALUES ('c5019fa5-7e78-4d8d-9feb-a3cdcfc52526', 'tenant-a', NULL, 'ca660e37-00af-4c76-a5b2-d3b55ea0dbf0', 'v1', 'tenant-a の記憶 1 東京 会議 プロジェクト1', 'ed6b6174b16e829904eb19e37af61bcdac066ad24d037aab65ab91746f903e4e', 'tenant-a の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-26T21:47:03.838Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ca660e37-00af-4c76-a5b2-d3b55ea0dbf0"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:03.841+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.462+09', 'ready', NULL, '2026-09-27 06:47:03.843436+09', '2026-09-27 06:47:04.259171+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('4524e767-7d53-4d56-afee-7c179d73cff5', 'tenant-a', NULL, '97b1cb39-ed27-4860-8f6d-94d3d59d1728', 'v1', 'tenant-a の記憶 2 東京 会議 プロジェクト2', 'd5783633ec67bfa023b1656bde0eda60589e932b2e5eb00bad51d9366c647db5', 'tenant-a の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-26T21:47:03.850Z", "kind": "stated", "speaker": "user", "sourceObservationId": "97b1cb39-ed27-4860-8f6d-94d3d59d1728"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:03.855+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.476+09', 'ready', NULL, '2026-09-27 06:47:03.855946+09', '2026-09-27 06:47:04.265654+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('225c787d-5262-477b-bc1b-34654cb65de6', 'tenant-a', NULL, 'f4f0f0cc-7f0a-410c-936b-c5dedca34fff', 'v1', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', 'd6d0bf800f00f3c35af37625f3533767a4db7afbdc77fe18c3bc2d5987ba70c1', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-26T21:47:03.861Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f4f0f0cc-7f0a-410c-936b-c5dedca34fff"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:03.865+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.486+09', 'ready', NULL, '2026-09-27 06:47:03.885404+09', '2026-09-27 06:47:04.294213+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('66efbfcd-434a-47ae-a9aa-e887b86be1c0', 'tenant-a', NULL, '785e607b-09f8-465a-8360-66b6da12655e', 'v1', 'tenant-a の記憶 5 東京 会議 プロジェクト0', 'edf34c29245092db70ab98057250239de4f569a113efa424ebda0f9cd882bd55', 'tenant-a の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-26T21:47:03.906Z", "kind": "stated", "speaker": "user", "sourceObservationId": "785e607b-09f8-465a-8360-66b6da12655e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:03.909+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.53+09', 'ready', NULL, '2026-09-27 06:47:03.910343+09', '2026-09-27 06:47:04.311376+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8270bfec-5d3f-42e1-ba2b-4ae7ed4e1021', 'tenant-a', NULL, '8a26664b-d83b-4747-8935-fec286b87004', 'v1', 'tenant-a の記憶 7 東京 会議 プロジェクト2', '0c60f6ec18ba3a28b875b6830e0201a28a0ce0a0831c5c1cfa14d9213f4fccc3', 'tenant-a の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-26T21:47:03.951Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8a26664b-d83b-4747-8935-fec286b87004"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:03.955+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.576+09', 'ready', NULL, '2026-09-27 06:47:03.956026+09', '2026-09-27 06:47:04.319453+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a2be48c4-6b6f-4f8e-a5bb-76911530e005', 'tenant-a', NULL, '593b2561-9ea2-4d11-8ea1-3342a5901237', 'v1', 'tenant-a の記憶 12 東京 会議 プロジェクト2', '1416843979dca4b10e813c98b42e4e64184da19a8246431ca987465bf0319a69', 'tenant-a の記憶 12 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.011Z", "kind": "stated", "speaker": "user", "sourceObservationId": "593b2561-9ea2-4d11-8ea1-3342a5901237"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.015+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.636+09', 'ready', NULL, '2026-09-27 06:47:04.016104+09', '2026-09-27 06:47:04.363652+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('99944142-5307-4131-a395-4bd0807c43c5', 'tenant-a', NULL, '50e57e74-0821-4d8b-b7c2-7cfddb065ad5', 'v1', 'tenant-a の記憶 13 東京 会議 プロジェクト3', '85fa57655dee036fb504dc9e026f2dfe383c1140f5fab5d93ff65f97a76f63c1', 'tenant-a の記憶 13 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.022Z", "kind": "stated", "speaker": "user", "sourceObservationId": "50e57e74-0821-4d8b-b7c2-7cfddb065ad5"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.025+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.646+09', 'ready', NULL, '2026-09-27 06:47:04.026517+09', '2026-09-27 06:47:04.367677+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('0cba8cd1-efff-426e-a281-288ac550bb0f', 'tenant-a', NULL, 'c8ac7390-3252-4f06-be88-830e09f53d68', 'v1', 'tenant-a の記憶 14 東京 会議 プロジェクト4', '566c00e514039c3cbdde42ca12af98244b4fc1d1fba5c31799c41667ccb84955', 'tenant-a の記憶 14 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.032Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c8ac7390-3252-4f06-be88-830e09f53d68"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.035+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.656+09', 'ready', NULL, '2026-09-27 06:47:04.03635+09', '2026-09-27 06:47:04.372009+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a5ba9494-0185-4a75-be8c-3fe7e27cb290', 'tenant-a', NULL, '565d53f9-614f-428c-a8a5-0ba159bef3cc', 'v1', 'tenant-a の記憶 15 東京 会議 プロジェクト0', 'f0b29bf3fc257d56d53bf3a40509a30894afa7846eb7397ab547ea18a3a29c38', 'tenant-a の記憶 15 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.044Z", "kind": "stated", "speaker": "user", "sourceObservationId": "565d53f9-614f-428c-a8a5-0ba159bef3cc"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.069+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.69+09', 'ready', NULL, '2026-09-27 06:47:04.069802+09', '2026-09-27 06:47:04.376093+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e6795385-77dc-4d84-b0bb-8471e7bd9096', 'tenant-a', NULL, 'aad771dc-afed-4aa9-8ac6-985e4c45c404', 'v1', 'tenant-a の記憶 4 東京 会議 プロジェクト4', '2d4011873ef8b25d39bde2a8122f185e9e032a938e8e1020e527a073b0930df3', 'tenant-a の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-26T21:47:03.894Z", "kind": "stated", "speaker": "user", "sourceObservationId": "aad771dc-afed-4aa9-8ac6-985e4c45c404"}', 'superseded', '66efbfcd-434a-47ae-a9aa-e887b86be1c0', NULL, '{}', NULL, '2026-09-27 06:47:03.897+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.518+09', 'ready', NULL, '2026-09-27 06:47:03.898255+09', '2026-09-27 06:47:04.495045+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('3eaafd2a-7b9d-4528-a456-aefa9334dced', 'tenant-a', NULL, '81b6f047-c32a-4faa-81e7-4c43558bfd27', 'v1', 'tenant-a の記憶 6 東京 会議 プロジェクト1', 'd930b5a8cf81e3b3b32791e8dae3c05994da72ef1265c035dfaf39080ed62dbe', 'tenant-a の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-26T21:47:03.915Z", "kind": "stated", "speaker": "user", "sourceObservationId": "81b6f047-c32a-4faa-81e7-4c43558bfd27"}', 'contested', NULL, '832a490f-cf53-43db-b433-359c0ce7c5b3', '{}', NULL, '2026-09-27 06:47:03.917+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.538+09', 'ready', NULL, '2026-09-27 06:47:03.918428+09', '2026-09-27 06:47:04.502472+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('49988af5-175e-46e3-a4d5-cd85fa4297ec', 'tenant-a', NULL, 'a661af1a-d001-48f9-bff4-af207f5001d3', 'v1', 'tenant-a の記憶 9 東京 会議 プロジェクト4', '4c241e9f2abb28b016af405d09bb673284fc201c4fac4a039faba6f8c7e22fc3', 'tenant-a の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-26T21:47:03.971Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a661af1a-d001-48f9-bff4-af207f5001d3"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-27 06:47:03.973+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.594+09', 'ready', NULL, '2026-09-27 06:47:03.97403+09', '2026-09-27 06:47:04.507591+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('68a58abd-6862-4aa9-bcc7-dfd9da2ee2e1', 'tenant-a', NULL, '82624b0d-d622-46d0-9166-4d45fb812afb', 'v1', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', 'f43c8e3670dc49dcd5e7d3d4067e6675ad27bf370e403c97f646b08db859894f', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-09-26T21:47:03.978Z", "kind": "stated", "speaker": "user", "sourceObservationId": "82624b0d-d622-46d0-9166-4d45fb812afb"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 06:47:03.98+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.601+09', 'ready', NULL, '2026-09-27 06:47:03.981468+09', '2026-09-27 06:47:04.509724+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ac5caf3f-e553-4536-b5cd-e6116d2e9dc4', 'tenant-a', NULL, '887696e5-5955-43c0-bd1c-9cd409050c81', 'v1', '[purged]', '8baacaa745d740261839f6dbe908954009bba75aead9ea0901933a52379e09f4', '[purged]', 'llm', 'stated', '{"at": "2026-09-26T21:47:03.985Z", "kind": "stated", "speaker": "user", "sourceObservationId": "887696e5-5955-43c0-bd1c-9cd409050c81"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 06:47:03.987+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.608+09', 'ready', '2026-09-27 06:47:04.517779+09', '2026-09-27 06:47:03.988219+09', '2026-09-27 06:47:04.517779+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('067e442f-f09a-4ebf-9968-33c232e62204', 'tenant-a', NULL, '88e63a9f-c033-4042-a7ca-2746552d8f17', 'v1', 'tenant-a の記憶 0 東京 会議 プロジェクト0', 'd3ea19d3736314cb9c467c1662164327f232b7f4614ea76f675772f69c277594', 'tenant-a の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-26T21:47:03.793Z", "kind": "stated", "speaker": "user", "sourceObservationId": "88e63a9f-c033-4042-a7ca-2746552d8f17"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:03.822+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.443+09', 'ready', NULL, '2026-09-27 06:47:03.825419+09', '2026-09-27 06:47:04.251287+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('86b07ad9-c438-4798-a7d2-5117484e7108', 'tenant-a', NULL, 'f066493f-c21b-4702-bc4a-ecf3191fe193', 'v1', 'tenant-a の記憶 16 東京 会議 プロジェクト1', 'ca52ff79646f23e88b31f2cd9bab84db866daa8ee904c6ffc4f2608348e05082', 'tenant-a の記憶 16 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.075Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f066493f-c21b-4702-bc4a-ecf3191fe193"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.079+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.7+09', 'ready', NULL, '2026-09-27 06:47:04.08006+09', '2026-09-27 06:47:04.379675+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b9be8551-2c8c-458e-a645-539c7b271415', 'tenant-a', NULL, '6ffd3b77-de42-4b81-afe0-9b7da404308b', 'v1', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', 'b143762528afffbb72a33fb24f70ebd4d19cd0cc89719dd7231a45971896fde7', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.088Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6ffd3b77-de42-4b81-afe0-9b7da404308b"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.091+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.712+09', 'ready', NULL, '2026-09-27 06:47:04.092221+09', '2026-09-27 06:47:04.383805+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1dce5856-2828-44f3-b941-a11b1b9aaa35', 'tenant-a', NULL, '3b1fd5ea-5d80-4244-b235-4006d046c621', 'v1', 'tenant-a の記憶 18 東京 会議 プロジェクト3', '6d3a158a624537a869f95ca05e650119d80bbe0cd4f796b22bc3c31ea83ada8a', 'tenant-a の記憶 18 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.098Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3b1fd5ea-5d80-4244-b235-4006d046c621"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.12+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.741+09', 'ready', NULL, '2026-09-27 06:47:04.121549+09', '2026-09-27 06:47:04.389741+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6eb13a38-d170-4dde-a76e-abcd9787bd78', 'tenant-a', NULL, '83fe7622-1fe7-4011-a8bc-61fc37fbb9bd', 'v1', 'tenant-a の記憶 19 東京 会議 プロジェクト4', '83b96ac18e746f06f8c77902fd8d7e7f3c59541caaa6ae2658298580ec04e043', 'tenant-a の記憶 19 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.130Z", "kind": "stated", "speaker": "user", "sourceObservationId": "83fe7622-1fe7-4011-a8bc-61fc37fbb9bd"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.133+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.754+09', 'ready', NULL, '2026-09-27 06:47:04.133499+09', '2026-09-27 06:47:04.416906+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('0835061e-e52f-43b1-b7ce-dc9f24f015d7', 'tenant-a', NULL, 'f35ea97a-39f7-4ad5-b887-f0e2ac32e409', 'v1', 'tenant-a の記憶 21 東京 会議 プロジェクト1', '4c3e66f819f467c96c28794801e751d2d4f6a9e3cd240dcfc9c3bf55c1cacc57', 'tenant-a の記憶 21 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.155Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f35ea97a-39f7-4ad5-b887-f0e2ac32e409"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.183+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.804+09', 'ready', NULL, '2026-09-27 06:47:04.18452+09', '2026-09-27 06:47:04.426325+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('aa907ddf-3b5d-400e-b915-c43a6f7af18e', 'tenant-a', NULL, 'e51bef24-8059-44d7-9e2c-a82635181928', 'v1', 'tenant-a の記憶 22 東京 会議 プロジェクト2', 'b72c9757075adda4486522b26365dfd82a6af69336a4c8f52d4771450c4ce0af', 'tenant-a の記憶 22 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.191Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e51bef24-8059-44d7-9e2c-a82635181928"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.194+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.815+09', 'ready', NULL, '2026-09-27 06:47:04.196267+09', '2026-09-27 06:47:04.430348+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('be6f5c44-8a10-4240-aa12-7bda7fab6b5c', 'tenant-a', NULL, 'e19224d6-a26c-4fa0-8131-fef711f8edf4', 'v1', 'tenant-a の記憶 23 東京 会議 プロジェクト3', '26d0049fe3cf7614c786a48dd795226413a4f6260e020ea8356d457c6ff1ca3f', 'tenant-a の記憶 23 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.200Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e19224d6-a26c-4fa0-8131-fef711f8edf4"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.204+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.825+09', 'ready', NULL, '2026-09-27 06:47:04.205511+09', '2026-09-27 06:47:04.434077+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('750c1584-6606-4c4a-b1c3-18011d4271da', 'tenant-a', NULL, 'bd3a67ce-1076-4e6b-ab88-942e0c756025', 'v1', 'tenant-a FAIL 埋め込み失敗 東京', 'ab1702dac85d2545c823794fc8106c348a2783463f2ac321911b7721adc9a696', 'tenant-a FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.210Z", "kind": "stated", "speaker": "user", "sourceObservationId": "bd3a67ce-1076-4e6b-ab88-942e0c756025"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.235+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.856+09', 'failed', NULL, '2026-09-27 06:47:04.236271+09', '2026-09-27 06:47:04.43788+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('36a018b7-2baa-4cb8-8ab4-090c046e3e96', 'tenant-a', NULL, '045bdbaf-c42f-4cab-af0b-c928bdfc8dd0', 'v1', 'tenant-a 未埋め込み 0', '756d0ee3ef05fe980db2aa5224ed49ab257c9c10a80d33a77df32294e4a9b497', 'tenant-a 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.440Z", "kind": "stated", "speaker": "user", "sourceObservationId": "045bdbaf-c42f-4cab-af0b-c928bdfc8dd0"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.442+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.063+09', 'pending', NULL, '2026-09-27 06:47:04.442941+09', '2026-09-27 06:47:04.442941+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a2ee63d6-f330-42aa-a2ab-fd96a7562c31', 'tenant-a', NULL, '810efc55-c962-41ac-8351-99e5945d0869', 'v1', 'tenant-a 未埋め込み 1', '7a1a046d3656ac2ae59f0f95d457c9c60be31eb915f2dd5cdc53822faaefdf48', 'tenant-a 未埋め込み 1', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.447Z", "kind": "stated", "speaker": "user", "sourceObservationId": "810efc55-c962-41ac-8351-99e5945d0869"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.45+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.071+09', 'pending', NULL, '2026-09-27 06:47:04.450907+09', '2026-09-27 06:47:04.450907+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b2035fac-a734-43ba-b5cc-f10c27817910', 'tenant-a', NULL, 'a5291402-6f6c-47eb-9650-6c2acf2ef3a5', 'v1', 'tenant-a 未埋め込み 2', '899e3558b907c6a4074d675812af26d32f5a4d665344080e52cfed3d3c1218f6', 'tenant-a 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.477Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a5291402-6f6c-47eb-9650-6c2acf2ef3a5"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.479+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.1+09', 'skipped', NULL, '2026-09-27 06:47:04.480016+09', '2026-09-27 06:47:04.492706+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('832a490f-cf53-43db-b433-359c0ce7c5b3', 'tenant-a', NULL, '169fe4f9-d83c-4bc1-a26c-35c910a04966', 'v1', 'tenant-a の記憶 8 東京 会議 プロジェクト3', 'b80d062281da38b404565ed86841de51799a3a0b5a8332e8ae6c080d35716009', 'tenant-a の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-26T21:47:03.962Z", "kind": "stated", "speaker": "user", "sourceObservationId": "169fe4f9-d83c-4bc1-a26c-35c910a04966"}', 'contested', NULL, '3eaafd2a-7b9d-4528-a456-aefa9334dced', '{}', NULL, '2026-09-27 06:47:03.964+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:21.585+09', 'ready', NULL, '2026-09-27 06:47:03.965565+09', '2026-09-27 06:47:04.502472+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('7fcf19ee-0459-4cd2-aafa-5e8f461a1b01', 'tenant-a', NULL, '8a076f36-f6f5-459b-8cdd-6a7350c02812', 'v1', 'tenant-a の記憶 20 東京 会議 プロジェクト0', '30b8312facf5b4d080051518335646cf1b0811d3dd74936bb276b5f511c2fda4', 'tenant-a の記憶 20 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.139Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8a076f36-f6f5-459b-8cdd-6a7350c02812"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.145+09', '2026-09-27 06:47:04.575+09', NULL, NULL, 1, 720, '2027-02-03 22:34:22.196+09', 'ready', NULL, '2026-09-27 06:47:04.146123+09', '2026-09-27 06:47:04.577144+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('05339903-a1c8-4d2e-9ab2-b5076861c246', 'tenant-b', NULL, '76c3d7a7-4581-4814-9bb4-878b5cf248b3', 'v1', 'tenant-b の記憶 1 東京 会議 プロジェクト1', 'b95da75a3bc21f8d9d823c4d001c8086e008dcc6b38e31d6ed7199e9b758b564', 'tenant-b の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.588Z", "kind": "stated", "speaker": "user", "sourceObservationId": "76c3d7a7-4581-4814-9bb4-878b5cf248b3"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.612+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.233+09', 'ready', NULL, '2026-09-27 06:47:04.613468+09', '2026-09-27 06:47:04.803188+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('655eec4c-c86e-4e79-a9c6-272dd91956ae', 'tenant-b', NULL, '177de721-aab2-42fa-b864-37dafe3272c3', 'v1', 'tenant-b の記憶 2 東京 会議 プロジェクト2', 'fef0437ad217559ad5fb73795ca3cec2b335060d36ad7ba7a9da30c623a8f0d3', 'tenant-b の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.618Z", "kind": "stated", "speaker": "user", "sourceObservationId": "177de721-aab2-42fa-b864-37dafe3272c3"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.621+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.242+09', 'ready', NULL, '2026-09-27 06:47:04.622442+09', '2026-09-27 06:47:04.807834+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('70d9d481-0c24-419d-8b8c-9c799ae20937', 'tenant-b', NULL, '6f659e44-a05b-4d48-9cef-fb48313ec4b9', 'v1', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', '4e273dcb447fab0d9f4acfd5e8288bf45f0c7eb77b08b9cc0534c25d49c0c4f8', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.629Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6f659e44-a05b-4d48-9cef-fb48313ec4b9"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.632+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.253+09', 'ready', NULL, '2026-09-27 06:47:04.6331+09', '2026-09-27 06:47:04.829203+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b9d95781-0306-4f16-970b-a6407dbf43d5', 'tenant-b', NULL, 'e293009b-c565-41a2-8250-73b7900e14c0', 'v1', 'tenant-b の記憶 5 東京 会議 プロジェクト0', '1d9b410d61390a28c636568bbffd238b4e1012db936d587ca2fb4c25642981e9', 'tenant-b の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.643Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e293009b-c565-41a2-8250-73b7900e14c0"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.647+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.268+09', 'ready', NULL, '2026-09-27 06:47:04.647873+09', '2026-09-27 06:47:04.838251+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('77f282a1-d45c-4f7e-b003-a80deaa55028', 'tenant-b', NULL, '4b4fce0d-e028-4459-ac60-fb1a7a20a2ef', 'v1', 'tenant-b の記憶 7 東京 会議 プロジェクト2', 'f1d4ed789aa4b33b86f74868c1d9f1efbac874dbb3cbbdd89a13eabcd6826704', 'tenant-b の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.658Z", "kind": "stated", "speaker": "user", "sourceObservationId": "4b4fce0d-e028-4459-ac60-fb1a7a20a2ef"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.661+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.282+09', 'ready', NULL, '2026-09-27 06:47:04.661393+09', '2026-09-27 06:47:04.846454+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ac7309cc-d0ce-4b13-83f4-94685cc6c8b7', 'tenant-b', NULL, '975dd48d-d7ea-44d1-888e-6d25332c0b71', 'v1', 'tenant-b の記憶 12 東京 会議 プロジェクト2', '7b361a170b64a9b41f97d624b8bc1cb0f2c68950bfea639ccb5a23c4344575f8', 'tenant-b の記憶 12 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.725Z", "kind": "stated", "speaker": "user", "sourceObservationId": "975dd48d-d7ea-44d1-888e-6d25332c0b71"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.727+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.348+09', 'ready', NULL, '2026-09-27 06:47:04.727851+09', '2026-09-27 06:47:04.866598+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('457bce5f-e77d-4b92-8d18-e37d9f632477', 'tenant-b', NULL, '2d27c2d7-31df-44b8-9559-37a9839a1780', 'v1', 'tenant-b の記憶 13 東京 会議 プロジェクト3', '0dc090582bdaf2135130a122f6f926027aa9346166b076aa7ce9d878071c18f3', 'tenant-b の記憶 13 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.731Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2d27c2d7-31df-44b8-9559-37a9839a1780"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.733+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.354+09', 'ready', NULL, '2026-09-27 06:47:04.734289+09', '2026-09-27 06:47:04.870025+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('16ac3149-2d51-4a65-8d1e-9fb359eab713', 'tenant-b', NULL, '334f7a38-7f81-434b-80cc-a5d0dc92e506', 'v1', 'tenant-b の記憶 15 東京 会議 プロジェクト0', '159e45fbd8a5ffaff4ae601883d4d60fd353ceca26759a1642630065cef3b241', 'tenant-b の記憶 15 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.766Z", "kind": "stated", "speaker": "user", "sourceObservationId": "334f7a38-7f81-434b-80cc-a5d0dc92e506"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.77+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.391+09', 'ready', NULL, '2026-09-27 06:47:04.771145+09', '2026-09-27 06:47:04.87872+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('4ca5d6d2-6b8c-4a0b-8970-f8589e4af8f3', 'tenant-b', NULL, 'ddafa6bf-1bdc-4798-a4d3-3eb97e5c654b', 'v1', 'tenant-b の記憶 4 東京 会議 プロジェクト4', '5940641d2d369c2cc336a4e7e0dfe324af8bd43c6c6bb540111ea25536b9f590', 'tenant-b の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.637Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ddafa6bf-1bdc-4798-a4d3-3eb97e5c654b"}', 'superseded', 'b9d95781-0306-4f16-970b-a6407dbf43d5', NULL, '{}', NULL, '2026-09-27 06:47:04.639+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.26+09', 'ready', NULL, '2026-09-27 06:47:04.639796+09', '2026-09-27 06:47:04.974076+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('290d95d6-4c0b-4562-988d-b823f1cd16a6', 'tenant-b', NULL, '8c7c0941-2135-41b6-911a-7bef9e538330', 'v1', 'tenant-b の記憶 6 東京 会議 プロジェクト1', '25dbc01aa826c3caa1c214b61d630f769615fc5a4f74f62be2b71c2a659e3fa8', 'tenant-b の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.652Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8c7c0941-2135-41b6-911a-7bef9e538330"}', 'contested', NULL, 'd9794124-d2d6-445d-9d43-a489e11c12d3', '{}', NULL, '2026-09-27 06:47:04.654+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.275+09', 'ready', NULL, '2026-09-27 06:47:04.655103+09', '2026-09-27 06:47:04.976923+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f0425304-d570-4912-a232-e76f59b1641a', 'tenant-b', NULL, '4076cbc1-1e4f-405c-ae37-518fcbfc94ff', 'v1', 'tenant-b の記憶 9 東京 会議 プロジェクト4', '1e67543f28e3ecb46017a56947f528295cfd849f37bbff911216c8f13f03cb45', 'tenant-b の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.701Z", "kind": "stated", "speaker": "user", "sourceObservationId": "4076cbc1-1e4f-405c-ae37-518fcbfc94ff"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.704+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.325+09', 'ready', NULL, '2026-09-27 06:47:04.705162+09', '2026-09-27 06:47:04.981495+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('37d9404a-ea7c-4588-99c9-8f76243a8c4d', 'tenant-b', NULL, '8a07f665-e2b2-4b97-9311-5aa2a3601482', 'v1', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', 'e3ce75d1b42cf68db24819b6cf5a26b4168b236f492bda9ec4f44f99baf6e59f', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.711Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8a07f665-e2b2-4b97-9311-5aa2a3601482"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.714+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.335+09', 'ready', NULL, '2026-09-27 06:47:04.714798+09', '2026-09-27 06:47:04.983672+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('085702e3-9122-4924-b3b6-a2aba20b3c50', 'tenant-b', NULL, 'e914f4e2-a1e6-4c22-814e-af8b1d0c5ed6', 'v1', '[purged]', '624794e8e55d99b8d71021f048790ff041d1bfb438372d59bcdfa91e5e3b0bcd', '[purged]', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.719Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e914f4e2-a1e6-4c22-814e-af8b1d0c5ed6"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.721+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.342+09', 'ready', '2026-09-27 06:47:04.988933+09', '2026-09-27 06:47:04.721704+09', '2026-09-27 06:47:04.988933+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6b663b08-a3b9-47c1-877f-437136fab799', 'tenant-b', NULL, '6e7fa68b-f899-4b06-80d4-a81cfb51cd85', 'v1', 'tenant-b の記憶 14 東京 会議 プロジェクト4', '8a607cfc5964eaf69142f32afe35b75600e27d38176864ada321967ce349bc64', 'tenant-b の記憶 14 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.737Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6e7fa68b-f899-4b06-80d4-a81cfb51cd85"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.739+09', '2026-09-27 06:47:05.026+09', NULL, NULL, 1, 720, '2027-02-03 22:34:22.647+09', 'ready', NULL, '2026-09-27 06:47:04.740213+09', '2026-09-27 06:47:05.028652+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('17bbbe8b-48ca-477d-9f23-ee0824a28178', 'tenant-b', NULL, '9e54e7f6-35ce-4678-b590-32302e50456b', 'v1', 'tenant-b の記憶 0 東京 会議 プロジェクト0', '081a9a9f113b084d0ccebeb4e29f753910bca11b2e4e20168eca50413e85a174', 'tenant-b の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.579Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9e54e7f6-35ce-4678-b590-32302e50456b"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.583+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.204+09', 'ready', NULL, '2026-09-27 06:47:04.583934+09', '2026-09-27 06:47:04.798692+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('5e63de98-905a-4fb3-8e65-45bd5c514b3c', 'tenant-b', NULL, '9e5082da-ac08-4c9b-a292-704def191716', 'v1', 'tenant-b の記憶 16 東京 会議 プロジェクト1', 'b8c54c018860dad1bd5d84c2883f7deef7dba67a41562560b7454f3565547826', 'tenant-b の記憶 16 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.777Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9e5082da-ac08-4c9b-a292-704def191716"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.779+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.4+09', 'ready', NULL, '2026-09-27 06:47:04.779666+09', '2026-09-27 06:47:04.914057+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('84a40b66-54af-4eea-9777-4b7c47a2ec64', 'tenant-b', NULL, '3628f18e-b9ef-4ba8-ad24-8b547af5649a', 'v1', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', '512794d1b4203897a59658ba1c10d0d4ff10f5d69627a6dffa186e0a86c02feb', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.783Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3628f18e-b9ef-4ba8-ad24-8b547af5649a"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.784+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.405+09', 'ready', NULL, '2026-09-27 06:47:04.785331+09', '2026-09-27 06:47:04.919671+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('492cdfac-fada-43de-9cde-ca890ec1f88d', 'tenant-b', NULL, '15956ed8-d1dd-4ebd-94fd-cddabc9da6bd', 'v1', 'tenant-b FAIL 埋め込み失敗 東京', 'dca6507a3912ad169580cf2764c29ddf080a9cbf73c32d7ddf16429d985d35ef', 'tenant-b FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.788Z", "kind": "stated", "speaker": "user", "sourceObservationId": "15956ed8-d1dd-4ebd-94fd-cddabc9da6bd"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.79+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.411+09', 'failed', NULL, '2026-09-27 06:47:04.790782+09', '2026-09-27 06:47:04.924347+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('7764b9f6-9eb7-4370-bfca-1197c5964425', 'tenant-b', NULL, 'd765d976-65b6-47cb-91a8-d13349544725', 'v1', 'tenant-b 未埋め込み 0', '4f033a8ab5dff18cce4bfac1ffa04151f80b45e51806b9cebeca92a143ae6386', 'tenant-b 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.929Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d765d976-65b6-47cb-91a8-d13349544725"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.932+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.553+09', 'pending', NULL, '2026-09-27 06:47:04.932465+09', '2026-09-27 06:47:04.932465+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('2c995ff0-846b-470b-9d57-7d41ba1e4e25', 'tenant-b', NULL, 'ca3c6a0e-fe92-4d6a-aed7-9d2e338c043d', 'v1', 'tenant-b 未埋め込み 1', '9d77f4b53475fe24e31aaa3bcdc02aa1a0786c37888dcee783f146c4aae191e2', 'tenant-b 未埋め込み 1', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.935Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ca3c6a0e-fe92-4d6a-aed7-9d2e338c043d"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.938+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.559+09', 'pending', NULL, '2026-09-27 06:47:04.938518+09', '2026-09-27 06:47:04.938518+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('65dcf125-5efb-4566-9735-57d445b78547', 'tenant-b', NULL, '2a05c925-c5a3-4090-a896-d53d2bdebcce', 'v1', 'tenant-b 未埋め込み 2', '318fb30d6dda58f1c972e4779c59979fbd926637878da937d6155ac62a286d02', 'tenant-b 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.944Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2a05c925-c5a3-4090-a896-d53d2bdebcce"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:04.948+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.569+09', 'skipped', NULL, '2026-09-27 06:47:04.965729+09', '2026-09-27 06:47:04.972319+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d9794124-d2d6-445d-9d43-a489e11c12d3', 'tenant-b', NULL, '29a5998c-465a-4df5-a3b3-57042fb3956f', 'v1', 'tenant-b の記憶 8 東京 会議 プロジェクト3', '03f24fe74d5d2e3d56878e412d3b0daf983f57c46d18f1bf25917b76cf7ef9f6', 'tenant-b の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-26T21:47:04.665Z", "kind": "stated", "speaker": "user", "sourceObservationId": "29a5998c-465a-4df5-a3b3-57042fb3956f"}', 'forgotten', NULL, '290d95d6-4c0b-4562-988d-b823f1cd16a6', '{}', NULL, '2026-09-27 06:47:04.667+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.288+09', 'ready', NULL, '2026-09-27 06:47:04.667742+09', '2026-09-27 06:47:04.992861+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1b9b19b9-a36c-42f6-ad73-dd1be3956fd1', 'tenant-c', NULL, 'd7d347fc-8855-49d0-a4ef-f42ca820c487', 'v1', 'tenant-c の記憶 1 東京 会議 プロジェクト1', 'f97a8b4d6e8a9c4b9cc08f892895a26c5150d4dc14b0da37a299e97b759312b2', 'tenant-c の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.039Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d7d347fc-8855-49d0-a4ef-f42ca820c487"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.042+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.663+09', 'ready', NULL, '2026-09-27 06:47:05.043136+09', '2026-09-27 06:47:05.227044+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('bf117f84-8fef-4dba-ad41-516b81ce1649', 'tenant-c', NULL, '96dff28e-bb33-4a79-adab-f2aa8fad7c11', 'v1', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', '94612eb1b4f64fa932a1d3db6feb48231cb950d9ffd00939776db4cf1eb29c26', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.057Z", "kind": "stated", "speaker": "user", "sourceObservationId": "96dff28e-bb33-4a79-adab-f2aa8fad7c11"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.087+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.708+09', 'ready', NULL, '2026-09-27 06:47:05.087919+09', '2026-09-27 06:47:05.259252+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('10563ca6-bc9c-48ba-9f6c-405444cfc9cb', 'tenant-c', NULL, '65414fe2-78c3-46ed-b0e4-f6ee55e408c5', 'v1', 'tenant-c の記憶 7 東京 会議 プロジェクト2', '8c524a04f68127aef3b7b341e63ac27629ee3136f0ef9da63934e27c206cb419', 'tenant-c の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.139Z", "kind": "stated", "speaker": "user", "sourceObservationId": "65414fe2-78c3-46ed-b0e4-f6ee55e408c5"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.142+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.763+09', 'ready', NULL, '2026-09-27 06:47:05.14269+09', '2026-09-27 06:47:05.279409+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('7c807ea0-c1dc-4b65-8123-411e0325f5ce', 'tenant-c', NULL, 'd39d6580-3b30-4c25-9b7a-82ecc090f4bd', 'v1', 'tenant-c の記憶 4 東京 会議 プロジェクト4', '81f4ee70cb39ef24184d9447f8e119462e2b333831286169f12207dd00f50327', 'tenant-c の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.094Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d39d6580-3b30-4c25-9b7a-82ecc090f4bd"}', 'superseded', 'eaf39e64-e7e9-4642-aa6b-e415f7bcfb1a', NULL, '{}', NULL, '2026-09-27 06:47:05.098+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.719+09', 'ready', NULL, '2026-09-27 06:47:05.098516+09', '2026-09-27 06:47:05.386496+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b05cf74d-9056-48d6-a7c3-fe9f92fe311a', 'tenant-c', NULL, 'bfee10e5-f991-45c6-a6e2-5d73b8587728', 'v1', 'tenant-c の記憶 6 東京 会議 プロジェクト1', '1349732c0ebd9031ddc9bcae41973c5c6b6ab2f76e2179b5374ad6957af1fe87', 'tenant-c の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.108Z", "kind": "stated", "speaker": "user", "sourceObservationId": "bfee10e5-f991-45c6-a6e2-5d73b8587728"}', 'contested', NULL, '78a6562a-224a-4cdc-a0ec-a01f70aa92f8', '{}', NULL, '2026-09-27 06:47:05.13+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.751+09', 'ready', NULL, '2026-09-27 06:47:05.131936+09', '2026-09-27 06:47:05.392375+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('eaf39e64-e7e9-4642-aa6b-e415f7bcfb1a', 'tenant-c', NULL, 'f7ffa030-0e96-43dd-8b54-1289a7d5f466', 'v1', 'tenant-c の記憶 5 東京 会議 プロジェクト0', '0996fea87104119898e02a0d9962c82a2dfe8c52e32205dc818277bcf516daf6', 'tenant-c の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.102Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f7ffa030-0e96-43dd-8b54-1289a7d5f466"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.104+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.725+09', 'ready', NULL, '2026-09-27 06:47:05.104492+09', '2026-09-27 06:47:05.409479+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c423022b-93bf-40d5-a507-6430f41caba8', 'tenant-c', NULL, 'efeb5cbd-7b75-4e52-94a7-e01bc2980a6e', 'v1', 'tenant-c の記憶 2 東京 会議 プロジェクト2', '2576291adf7ad31335c6494eb95a197053599c859b1067bc5f6b08c63fbd8fc2', 'tenant-c の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.047Z", "kind": "stated", "speaker": "user", "sourceObservationId": "efeb5cbd-7b75-4e52-94a7-e01bc2980a6e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.05+09', '2026-09-27 06:47:05.422+09', NULL, NULL, 1, 720, '2027-02-03 22:34:23.043+09', 'ready', NULL, '2026-09-27 06:47:05.051067+09', '2026-09-27 06:47:05.42301+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f74f1a5e-9254-4da2-b201-793f4a707663', 'tenant-c', NULL, '40f8d001-aa71-4262-ade3-b9352dc73ca3', 'v1', 'tenant-c の記憶 0 東京 会議 プロジェクト0', '0d78da8c6a4e2de262064e70959180f45578ab348746afc04814736d3ec98420', 'tenant-c の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.031Z", "kind": "stated", "speaker": "user", "sourceObservationId": "40f8d001-aa71-4262-ade3-b9352dc73ca3"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.034+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.655+09', 'ready', NULL, '2026-09-27 06:47:05.034794+09', '2026-09-27 06:47:05.22221+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('27c504ea-4489-41ee-b6a0-d402b449ee6f', 'tenant-c', NULL, 'd8b322fb-02ba-4c39-928f-2a7a4f3d0ad7', 'v1', 'tenant-c FAIL 埋め込み失敗 東京', '985f97e69b2fc62b500ebd50803bce5a72393d80852f55d01d88a21002fd7746', 'tenant-c FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.209Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d8b322fb-02ba-4c39-928f-2a7a4f3d0ad7"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.211+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.832+09', 'failed', NULL, '2026-09-27 06:47:05.212671+09', '2026-09-27 06:47:05.301449+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6e9d888c-c626-474d-900c-29ddbef80fef', 'tenant-c', NULL, 'f5c401fb-6edd-48c4-ba8b-46af5621c7bb', 'v1', 'tenant-c 未埋め込み 0', 'dbbed7a9da3bc87703ee74ec7fcbae128292a28245a094e1e7fe55b2e761766d', 'tenant-c 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.328Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f5c401fb-6edd-48c4-ba8b-46af5621c7bb"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.331+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.952+09', 'pending', NULL, '2026-09-27 06:47:05.33315+09', '2026-09-27 06:47:05.33315+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1ec5034e-fd0e-4d63-bd8f-26843d448006', 'tenant-c', NULL, '8eeada59-c215-444f-9097-97eb675ddaa0', 'v1', 'tenant-c 未埋め込み 1', '6fef40b085316dc1f9517118e7701e59fddc1231ce2b4b7b03aaf45936697d74', 'tenant-c 未埋め込み 1', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.339Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8eeada59-c215-444f-9097-97eb675ddaa0"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.341+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.962+09', 'pending', NULL, '2026-09-27 06:47:05.341478+09', '2026-09-27 06:47:05.341478+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('faa17efc-d683-42fe-bc28-4720ea837a52', 'tenant-c', NULL, 'e40adc96-c6a2-439a-8743-d9483aab7020', 'v1', 'tenant-c 未埋め込み 2', 'd4169a93c46303e6cc20af167d50c6ffb9c86896911949620cd36e561554b6c1', 'tenant-c 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.350Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e40adc96-c6a2-439a-8743-d9483aab7020"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.355+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.976+09', 'skipped', NULL, '2026-09-27 06:47:05.356845+09', '2026-09-27 06:47:05.381693+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('78a6562a-224a-4cdc-a0ec-a01f70aa92f8', 'tenant-c', NULL, 'f1e670f7-fd06-4da5-8d85-b1991c437e3b', 'v1', 'tenant-c の記憶 8 東京 会議 プロジェクト3', '27955d03f0fb4db217579a1e5dbf74beed76d3f569305b1ab21cd24db6b92e36', 'tenant-c の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.146Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f1e670f7-fd06-4da5-8d85-b1991c437e3b"}', 'contested', NULL, 'b05cf74d-9056-48d6-a7c3-fe9f92fe311a', '{}', NULL, '2026-09-27 06:47:05.148+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.769+09', 'ready', NULL, '2026-09-27 06:47:05.148639+09', '2026-09-27 06:47:05.392375+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1b0ed14f-9100-45fb-9a56-46163fd46ff5', 'tenant-c', NULL, 'd18558a0-d1e2-4cff-ab59-9a3dbfc90e65', 'v1', 'tenant-c の記憶 9 東京 会議 プロジェクト4', 'd8961ae07e5a93b6b0dc84ea6ee4aa46d7a585e6dfcbda5aaddc38a2ce3974b6', 'tenant-c の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.152Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d18558a0-d1e2-4cff-ab59-9a3dbfc90e65"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.155+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.776+09', 'ready', NULL, '2026-09-27 06:47:05.155438+09', '2026-09-27 06:47:05.396913+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('cb6047fc-1d5d-4f42-b4a1-0869ab8c01d1', 'tenant-c', NULL, 'b33e68b1-f572-4b3a-a99d-0296c22594ce', 'v1', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', 'be6295fd3fa665a4400e99e456e7ac4a6311b950abd5ab167494cf5cf1661dc4', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.159Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b33e68b1-f572-4b3a-a99d-0296c22594ce"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.161+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.782+09', 'ready', NULL, '2026-09-27 06:47:05.162427+09', '2026-09-27 06:47:05.399306+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('eabc19c0-408b-4906-9c0b-c4cc03590564', 'tenant-c', NULL, 'c113d9b0-f9a4-4959-a843-8596f8121a3a', 'v1', '[purged]', '90508b50cef379d5c03fa9f0c876b432c0e3fe77e30b0a0ccc82349c9d4a406f', '[purged]', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.199Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c113d9b0-f9a4-4959-a843-8596f8121a3a"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.203+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:22.824+09', 'ready', '2026-09-27 06:47:05.405642+09', '2026-09-27 06:47:05.204121+09', '2026-09-27 06:47:05.405642+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('58208bdb-901d-4dbb-bb18-191dca147cad', 'tenant-a2', NULL, 'a6a8e7f1-0b79-414e-a622-bbc2eff6de18', 'v1', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', 'a785d27623732af65fc0f05c80ea5e8638cd85eb944016167297bd92393c0331', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.469Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a6a8e7f1-0b79-414e-a622-bbc2eff6de18"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.471+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.092+09', 'ready', NULL, '2026-09-27 06:47:05.471381+09', '2026-09-27 06:47:05.544761+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('78d7dd8f-9d66-44e9-b0f6-e12e21fa9701', 'tenant-a2', NULL, '138d04b2-1698-46bd-801e-73d94ba8ef47', 'v1', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', '2ff9054147bebbf3ab7b87786763739a75177d4a5b1f441bea040bf1eca421f4', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.482Z", "kind": "stated", "speaker": "user", "sourceObservationId": "138d04b2-1698-46bd-801e-73d94ba8ef47"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.485+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.106+09', 'ready', NULL, '2026-09-27 06:47:05.486026+09', '2026-09-27 06:47:05.558473+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('663d79c0-8de7-4b0d-8b9e-161a947bc954', 'tenant-a2', NULL, '67606c7e-a4aa-4ea3-9d3b-609d7b2bea60', 'v1', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', '914fb28b9e9744124fe125428a1d2ccdd0770428843fc02994496676178c35ee', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.494Z", "kind": "stated", "speaker": "user", "sourceObservationId": "67606c7e-a4aa-4ea3-9d3b-609d7b2bea60"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.495+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.116+09', 'ready', NULL, '2026-09-27 06:47:05.496143+09', '2026-09-27 06:47:05.565808+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('bc45305e-f66b-4259-87fc-7e95d0aaf321', 'tenant-a2', NULL, 'aad7e883-200b-42cc-a26f-f04e84072157', 'v1', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', '24ab90528718614c3e988124ed86cb1748700763560be7ef27c8bf4b5dcfd1ab', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.475Z", "kind": "stated", "speaker": "user", "sourceObservationId": "aad7e883-200b-42cc-a26f-f04e84072157"}', 'superseded', '78d7dd8f-9d66-44e9-b0f6-e12e21fa9701', NULL, '{}', NULL, '2026-09-27 06:47:05.477+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.098+09', 'ready', NULL, '2026-09-27 06:47:05.477985+09', '2026-09-27 06:47:05.622294+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('de88d53a-db55-4df4-a95e-13076083d22f', 'tenant-a2', NULL, '0ce2d2e7-0409-4de0-836a-c87fae1cccf1', 'v1', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', '7592207a458219fa91a20d15fb9715e0462c1b13647e460421449a8734cc3f3b', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.489Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0ce2d2e7-0409-4de0-836a-c87fae1cccf1"}', 'contested', NULL, '71a462b3-bbbd-4382-9bc3-6f02244ea4ed', '{}', NULL, '2026-09-27 06:47:05.491+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.112+09', 'ready', NULL, '2026-09-27 06:47:05.491531+09', '2026-09-27 06:47:05.624267+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('7a31e516-db8c-4770-bef1-636a6939e8ce', 'tenant-a2', NULL, 'b0e496ff-7ca1-4b31-929d-632cbb5b810e', 'v1', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', '4cf1d599eeca369fd9803aad38e37386c99caf014b2df0588842e802cb851f62', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.459Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b0e496ff-7ca1-4b31-929d-632cbb5b810e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.464+09', '2026-09-27 06:47:05.649+09', NULL, NULL, 1, 720, '2027-02-03 22:34:23.27+09', 'ready', NULL, '2026-09-27 06:47:05.464731+09', '2026-09-27 06:47:05.650558+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c2cbb566-6b1c-40b0-8091-b7eb4723754a', 'tenant-a2', NULL, '73796916-1502-4964-8d5e-2695e7bc3d3b', 'v1', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', 'cc6965c4ce873014f25affb39c4d6773bd8fb57667bfa6de70490b30eeb8b9c2', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.424Z", "kind": "stated", "speaker": "user", "sourceObservationId": "73796916-1502-4964-8d5e-2695e7bc3d3b"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.426+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.047+09', 'ready', NULL, '2026-09-27 06:47:05.426365+09', '2026-09-27 06:47:05.534976+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('24540d97-3daa-4014-9128-0819f6fba9db', 'tenant-a2', NULL, '233db03d-a4af-4937-b018-5e849d6f5473', 'v1', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', '98db05eaf2b468995ca8ddfb04238b6a3f78950faff175f1bfb6be45a8249e43', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.428Z", "kind": "stated", "speaker": "user", "sourceObservationId": "233db03d-a4af-4937-b018-5e849d6f5473"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.43+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.051+09', 'ready', NULL, '2026-09-27 06:47:05.452147+09', '2026-09-27 06:47:05.538403+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e5e2ff1e-c44c-413d-8396-e93c413c983d', 'tenant-a2', NULL, '0c4dd196-352a-4ac8-9780-92a9f7e415a0', 'v1', 'tenant-a2 FAIL 埋め込み失敗 東京', '72456a5d7a68e3f7d1e7d082bd8429d137478336dc0b7ab44c25aae0508cf9c7', 'tenant-a2 FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.526Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0c4dd196-352a-4ac8-9780-92a9f7e415a0"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.528+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.149+09', 'failed', NULL, '2026-09-27 06:47:05.528515+09', '2026-09-27 06:47:05.596842+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ad7bdf2d-6509-4805-958f-f5a36bb2cbd2', 'tenant-a2', NULL, '3f2110c9-4c4e-4ead-9730-8c6c547dd03f', 'v1', 'tenant-a2 未埋め込み 2', '361bf58e0bbb5d4804764e21fd48bddde845290c4fcd3281b746852036325696', 'tenant-a2 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.614Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3f2110c9-4c4e-4ead-9730-8c6c547dd03f"}', 'active', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.616+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.237+09', 'skipped', NULL, '2026-09-27 06:47:05.616697+09', '2026-09-27 06:47:05.620579+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('71a462b3-bbbd-4382-9bc3-6f02244ea4ed', 'tenant-a2', NULL, 'd4daa1df-c124-447c-8d28-b2e87dde68af', 'v1', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', '97de39f5fe1e8a6b2164b4726c2ae28bd112a4222632a171a6a79d866131fa79', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.499Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d4daa1df-c124-447c-8d28-b2e87dde68af"}', 'contested', NULL, 'de88d53a-db55-4df4-a95e-13076083d22f', '{}', NULL, '2026-09-27 06:47:05.501+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.122+09', 'ready', NULL, '2026-09-27 06:47:05.501582+09', '2026-09-27 06:47:05.624267+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b41b86fd-7f83-43c4-8230-de53e8cf2435', 'tenant-a2', NULL, '39cdbcfd-181b-4dcd-9dee-6177061a8998', 'v1', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', 'f43da00aa2d66eb30de895210fc22e5cba0548b91eb41edc808208389480c46c', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.505Z", "kind": "stated", "speaker": "user", "sourceObservationId": "39cdbcfd-181b-4dcd-9dee-6177061a8998"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.506+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.127+09', 'ready', NULL, '2026-09-27 06:47:05.506815+09', '2026-09-27 06:47:05.627837+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('36927efd-7c78-4194-b1d8-ef20806185a0', 'tenant-a2', NULL, '0c15739e-1b43-4d52-9b78-945486a3165d', 'v1', 'tenant-a2 未埋め込み 0', '096af51a3f55ac6f12d4f7ae6b8dadd71299c722c9f56ac9764db3bd05d536e4', 'tenant-a2 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.600Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0c15739e-1b43-4d52-9b78-945486a3165d"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.602+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.223+09', 'pending', NULL, '2026-09-27 06:47:05.603378+09', '2026-09-27 06:47:05.629246+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('85ffcbdc-c509-4a19-b40f-b20701b86538', 'tenant-a2', NULL, '113280e5-d14c-4d3c-b34a-717ac73f530b', 'v1', '[purged]', 'e78005a62ce1fe1dc602590187cd521751267c830e60191f8b6622dafb10a298', '[purged]', 'llm', 'stated', '{"at": "2026-09-26T21:47:05.607Z", "kind": "stated", "speaker": "user", "sourceObservationId": "113280e5-d14c-4d3c-b34a-717ac73f530b"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-27 06:47:05.609+09', NULL, NULL, NULL, 1, 720, '2027-02-03 22:34:23.23+09', 'pending', '2026-09-27 06:47:05.634398+09', '2026-09-27 06:47:05.610101+09', '2026-09-27 06:47:05.634398+09', NULL, NULL, NULL, '{}', NULL, NULL);


--
-- Data for Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'f74f1a5e-9254-4da2-b201-793f4a707663', '[16,772,45,207]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 06:47:05.220817+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '1b9b19b9-a36c-42f6-ad73-dd1be3956fd1', '[16,773,45,208]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 06:47:05.226005+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'c423022b-93bf-40d5-a507-6430f41caba8', '[16,774,45,209]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 06:47:05.230496+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'bf117f84-8fef-4dba-ad41-516b81ce1649', '[0,0,0,0]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 06:47:05.258264+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '7c807ea0-c1dc-4b65-8123-411e0325f5ce', '[16,776,45,211]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 06:47:05.263799+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'eaf39e64-e7e9-4642-aa6b-e415f7bcfb1a', '[16,777,45,207]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 06:47:05.268449+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'b05cf74d-9056-48d6-a7c3-fe9f92fe311a', '[16,778,45,208]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 06:47:05.272841+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '10563ca6-bc9c-48ba-9f6c-405444cfc9cb', '[16,779,45,209]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 06:47:05.278418+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '78a6562a-224a-4cdc-a0ec-a01f70aa92f8', '[16,780,45,210]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 06:47:05.282188+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '1b0ed14f-9100-45fb-9a56-46163fd46ff5', '[16,781,45,211]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 06:47:05.285595+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'cb6047fc-1d5d-4f42-b4a1-0869ab8c01d1', '[0,0,0,0]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-27 06:47:05.290164+09');


--
-- Data for Name: memory_embeddings_test_fixture_model_3; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '067e442f-f09a-4ebf-9968-33c232e62204', '[677,880,478]', 'fixture-model', '2026-09-27 06:47:04.248616+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'c5019fa5-7e78-4d8d-9feb-a3cdcfc52526', '[678,881,478]', 'fixture-model', '2026-09-27 06:47:04.256027+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '4524e767-7d53-4d56-afee-7c179d73cff5', '[679,882,478]', 'fixture-model', '2026-09-27 06:47:04.264393+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '225c787d-5262-477b-bc1b-34654cb65de6', '[0,0,0]', 'fixture-model', '2026-09-27 06:47:04.291897+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'e6795385-77dc-4d84-b0bb-8471e7bd9096', '[681,884,478]', 'fixture-model', '2026-09-27 06:47:04.301004+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '66efbfcd-434a-47ae-a9aa-e887b86be1c0', '[677,885,478]', 'fixture-model', '2026-09-27 06:47:04.310055+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '3eaafd2a-7b9d-4528-a456-aefa9334dced', '[678,886,478]', 'fixture-model', '2026-09-27 06:47:04.314801+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '8270bfec-5d3f-42e1-ba2b-4ae7ed4e1021', '[679,887,478]', 'fixture-model', '2026-09-27 06:47:04.31858+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '832a490f-cf53-43db-b433-359c0ce7c5b3', '[680,888,478]', 'fixture-model', '2026-09-27 06:47:04.322227+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '49988af5-175e-46e3-a4d5-cd85fa4297ec', '[681,889,478]', 'fixture-model', '2026-09-27 06:47:04.346853+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '68a58abd-6862-4aa9-bcc7-dfd9da2ee2e1', '[0,0,0]', 'fixture-model', '2026-09-27 06:47:04.352193+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'a2be48c4-6b6f-4f8e-a5bb-76911530e005', '[855,769,464]', 'fixture-model', '2026-09-27 06:47:04.362847+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '99944142-5307-4131-a395-4bd0807c43c5', '[855,770,465]', 'fixture-model', '2026-09-27 06:47:04.366542+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '0cba8cd1-efff-426e-a281-288ac550bb0f', '[855,771,466]', 'fixture-model', '2026-09-27 06:47:04.371054+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'a5ba9494-0185-4a75-be8c-3fe7e27cb290', '[855,767,467]', 'fixture-model', '2026-09-27 06:47:04.375309+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '86b07ad9-c438-4798-a7d2-5117484e7108', '[855,768,468]', 'fixture-model', '2026-09-27 06:47:04.378801+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'b9be8551-2c8c-458e-a645-539c7b271415', '[0,0,0]', 'fixture-model', '2026-09-27 06:47:04.382723+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '1dce5856-2828-44f3-b941-a11b1b9aaa35', '[855,770,470]', 'fixture-model', '2026-09-27 06:47:04.388354+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '6eb13a38-d170-4dde-a76e-abcd9787bd78', '[855,771,471]', 'fixture-model', '2026-09-27 06:47:04.415736+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '7fcf19ee-0459-4cd2-aafa-5e8f461a1b01', '[855,768,462]', 'fixture-model', '2026-09-27 06:47:04.421191+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '0835061e-e52f-43b1-b7ce-dc9f24f015d7', '[855,769,463]', 'fixture-model', '2026-09-27 06:47:04.425184+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'aa907ddf-3b5d-400e-b915-c43a6f7af18e', '[855,770,464]', 'fixture-model', '2026-09-27 06:47:04.429493+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'be6f5c44-8a10-4240-aa12-7bda7fab6b5c', '[855,771,465]', 'fixture-model', '2026-09-27 06:47:04.43314+09');


--
-- Data for Name: memory_embeddings_testkit_deterministic_8; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '17bbbe8b-48ca-477d-9f23-ee0824a28178', '[839,69,404,38,174,703,638,168]', 'deterministic', '2026-09-27 06:47:04.797408+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '05339903-a1c8-4d2e-9ab2-b5076861c246', '[839,69,404,39,174,704,638,168]', 'deterministic', '2026-09-27 06:47:04.801968+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '655eec4c-c86e-4e79-a9c6-272dd91956ae', '[839,69,404,40,174,705,638,168]', 'deterministic', '2026-09-27 06:47:04.806866+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '70d9d481-0c24-419d-8b8c-9c799ae20937', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-27 06:47:04.810844+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '4ca5d6d2-6b8c-4a0b-8970-f8589e4af8f3', '[839,69,404,42,174,707,638,168]', 'deterministic', '2026-09-27 06:47:04.832919+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'b9d95781-0306-4f16-970b-a6407dbf43d5', '[839,69,404,38,174,708,638,168]', 'deterministic', '2026-09-27 06:47:04.837297+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '290d95d6-4c0b-4562-988d-b823f1cd16a6', '[839,69,404,39,174,709,638,168]', 'deterministic', '2026-09-27 06:47:04.841464+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '77f282a1-d45c-4f7e-b003-a80deaa55028', '[839,69,404,40,174,710,638,168]', 'deterministic', '2026-09-27 06:47:04.8454+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'd9794124-d2d6-445d-9d43-a489e11c12d3', '[839,69,404,41,174,711,638,168]', 'deterministic', '2026-09-27 06:47:04.849964+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'f0425304-d570-4912-a232-e76f59b1641a', '[839,69,404,42,174,712,638,168]', 'deterministic', '2026-09-27 06:47:04.85367+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '37d9404a-ea7c-4588-99c9-8f76243a8c4d', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-27 06:47:04.857186+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'ac7309cc-d0ce-4b13-83f4-94685cc6c8b7', '[218,229,101,23,993,197,634,691]', 'deterministic', '2026-09-27 06:47:04.865649+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '457bce5f-e77d-4b92-8d18-e37d9f632477', '[218,229,101,23,994,197,635,691]', 'deterministic', '2026-09-27 06:47:04.869347+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '6b663b08-a3b9-47c1-877f-437136fab799', '[218,229,101,23,995,197,636,691]', 'deterministic', '2026-09-27 06:47:04.873104+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '16ac3149-2d51-4a65-8d1e-9fb359eab713', '[218,229,101,23,991,197,637,691]', 'deterministic', '2026-09-27 06:47:04.877794+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '5e63de98-905a-4fb3-8e65-45bd5c514b3c', '[218,229,101,23,992,197,638,691]', 'deterministic', '2026-09-27 06:47:04.912222+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '84a40b66-54af-4eea-9777-4b7c47a2ec64', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-27 06:47:04.918812+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'c2cbb566-6b1c-40b0-8091-b7eb4723754a', '[236,824,78,391,51,180,632,690]', 'deterministic', '2026-09-27 06:47:05.534231+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '24540d97-3daa-4014-9128-0819f6fba9db', '[236,824,78,391,52,180,633,690]', 'deterministic', '2026-09-27 06:47:05.537546+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '7a31e516-db8c-4770-bef1-636a6939e8ce', '[236,824,78,391,53,180,634,690]', 'deterministic', '2026-09-27 06:47:05.54084+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '58208bdb-901d-4dbb-bb18-191dca147cad', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-27 06:47:05.544028+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'bc45305e-f66b-4259-87fc-7e95d0aaf321', '[236,824,78,391,55,180,636,690]', 'deterministic', '2026-09-27 06:47:05.551394+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '78d7dd8f-9d66-44e9-b0f6-e12e21fa9701', '[236,824,78,391,51,180,637,690]', 'deterministic', '2026-09-27 06:47:05.557406+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'de88d53a-db55-4df4-a95e-13076083d22f', '[236,824,78,391,52,180,638,690]', 'deterministic', '2026-09-27 06:47:05.561204+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '663d79c0-8de7-4b0d-8b9e-161a947bc954', '[236,824,78,391,53,180,639,690]', 'deterministic', '2026-09-27 06:47:05.564996+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '71a462b3-bbbd-4382-9bc3-6f02244ea4ed', '[236,824,78,391,54,180,640,690]', 'deterministic', '2026-09-27 06:47:05.56911+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'b41b86fd-7f83-43c4-8230-de53e8cf2435', '[236,824,78,391,55,180,641,690]', 'deterministic', '2026-09-27 06:47:05.572997+09');


--
-- Data for Name: memory_events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_events VALUES ('f1d75bb7-919b-46f8-b28b-5ddf8b7a9e51', 'tenant-a', '067e442f-f09a-4ebf-9968-33c232e62204', 'created', '2026-09-27 06:47:03.833+09', '{"type": "system"}', 'tenant-a の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "88e63a9f-c033-4042-a7ca-2746552d8f17"}');
INSERT INTO public.memory_events VALUES ('2280c52f-9e31-4574-b1b0-ca0ffb853506', 'tenant-a', 'c5019fa5-7e78-4d8d-9feb-a3cdcfc52526', 'created', '2026-09-27 06:47:03.847+09', '{"type": "system"}', 'tenant-a の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ca660e37-00af-4c76-a5b2-d3b55ea0dbf0"}');
INSERT INTO public.memory_events VALUES ('641c9eab-f58c-4d5d-8667-7b6e22d973df', 'tenant-a', '4524e767-7d53-4d56-afee-7c179d73cff5', 'created', '2026-09-27 06:47:03.859+09', '{"type": "system"}', 'tenant-a の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "97b1cb39-ed27-4860-8f6d-94d3d59d1728"}');
INSERT INTO public.memory_events VALUES ('c19cbe16-13d6-4576-bfc3-c00724f11825', 'tenant-a', '225c787d-5262-477b-bc1b-34654cb65de6', 'created', '2026-09-27 06:47:03.89+09', '{"type": "system"}', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f4f0f0cc-7f0a-410c-936b-c5dedca34fff"}');
INSERT INTO public.memory_events VALUES ('842013c3-faa5-44be-b7ee-5f00e92d0147', 'tenant-a', 'e6795385-77dc-4d84-b0bb-8471e7bd9096', 'created', '2026-09-27 06:47:03.903+09', '{"type": "system"}', 'tenant-a の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "aad771dc-afed-4aa9-8ac6-985e4c45c404"}');
INSERT INTO public.memory_events VALUES ('906c57a4-70e1-4885-8469-9a3c14678dee', 'tenant-a', '66efbfcd-434a-47ae-a9aa-e887b86be1c0', 'created', '2026-09-27 06:47:03.913+09', '{"type": "system"}', 'tenant-a の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "785e607b-09f8-465a-8360-66b6da12655e"}');
INSERT INTO public.memory_events VALUES ('f0ca148d-1ec3-4cfc-8f2e-dbca34c2a416', 'tenant-a', '3eaafd2a-7b9d-4528-a456-aefa9334dced', 'created', '2026-09-27 06:47:03.948+09', '{"type": "system"}', 'tenant-a の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "81b6f047-c32a-4faa-81e7-4c43558bfd27"}');
INSERT INTO public.memory_events VALUES ('d89e4d0e-bd32-45af-8cbb-44ab106ea8e2', 'tenant-a', '8270bfec-5d3f-42e1-ba2b-4ae7ed4e1021', 'created', '2026-09-27 06:47:03.959+09', '{"type": "system"}', 'tenant-a の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8a26664b-d83b-4747-8935-fec286b87004"}');
INSERT INTO public.memory_events VALUES ('a9494296-2a20-440e-a71f-fbad4af9ff85', 'tenant-a', '832a490f-cf53-43db-b433-359c0ce7c5b3', 'created', '2026-09-27 06:47:03.969+09', '{"type": "system"}', 'tenant-a の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "169fe4f9-d83c-4bc1-a26c-35c910a04966"}');
INSERT INTO public.memory_events VALUES ('7ba35864-4883-4e6f-912c-f82ced4e2729', 'tenant-a', '49988af5-175e-46e3-a4d5-cd85fa4297ec', 'created', '2026-09-27 06:47:03.976+09', '{"type": "system"}', 'tenant-a の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a661af1a-d001-48f9-bff4-af207f5001d3"}');
INSERT INTO public.memory_events VALUES ('522fc05d-4015-4bd7-a992-9a0e31eab989', 'tenant-a', '68a58abd-6862-4aa9-bcc7-dfd9da2ee2e1', 'created', '2026-09-27 06:47:03.983+09', '{"type": "system"}', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "82624b0d-d622-46d0-9166-4d45fb812afb"}');
INSERT INTO public.memory_events VALUES ('800166f4-4b10-4c9b-abcc-b6f1408aaadc', 'tenant-a', 'ac5caf3f-e553-4536-b5cd-e6116d2e9dc4', 'created', '2026-09-27 06:47:03.99+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "887696e5-5955-43c0-bd1c-9cd409050c81"}');
INSERT INTO public.memory_events VALUES ('c2bea09c-fe3c-4385-b864-1aaf2d2abb0c', 'tenant-a', 'a2be48c4-6b6f-4f8e-a5bb-76911530e005', 'created', '2026-09-27 06:47:04.02+09', '{"type": "system"}', 'tenant-a の記憶 12 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "593b2561-9ea2-4d11-8ea1-3342a5901237"}');
INSERT INTO public.memory_events VALUES ('b811e6c8-c987-41fe-b9f0-0a173c643ffc', 'tenant-a', '99944142-5307-4131-a395-4bd0807c43c5', 'created', '2026-09-27 06:47:04.029+09', '{"type": "system"}', 'tenant-a の記憶 13 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "50e57e74-0821-4d8b-b7c2-7cfddb065ad5"}');
INSERT INTO public.memory_events VALUES ('5da8c399-8c90-4df3-b19d-00a76ad552c7', 'tenant-a', '0cba8cd1-efff-426e-a281-288ac550bb0f', 'created', '2026-09-27 06:47:04.038+09', '{"type": "system"}', 'tenant-a の記憶 14 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c8ac7390-3252-4f06-be88-830e09f53d68"}');
INSERT INTO public.memory_events VALUES ('a17c8b81-cf2b-432f-95d9-8d9b5c0452a4', 'tenant-a', 'a5ba9494-0185-4a75-be8c-3fe7e27cb290', 'created', '2026-09-27 06:47:04.072+09', '{"type": "system"}', 'tenant-a の記憶 15 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "565d53f9-614f-428c-a8a5-0ba159bef3cc"}');
INSERT INTO public.memory_events VALUES ('3bb50018-715a-4998-9bf1-d51fa64cc510', 'tenant-a', '86b07ad9-c438-4798-a7d2-5117484e7108', 'created', '2026-09-27 06:47:04.084+09', '{"type": "system"}', 'tenant-a の記憶 16 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f066493f-c21b-4702-bc4a-ecf3191fe193"}');
INSERT INTO public.memory_events VALUES ('f525c9f5-7cf9-4fc9-a4ba-9f06cfd7c35c', 'tenant-a', 'b9be8551-2c8c-458e-a645-539c7b271415', 'created', '2026-09-27 06:47:04.095+09', '{"type": "system"}', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6ffd3b77-de42-4b81-afe0-9b7da404308b"}');
INSERT INTO public.memory_events VALUES ('01eae90a-a1ef-4c84-a0ae-a8f04cdf2a53', 'tenant-a', '1dce5856-2828-44f3-b941-a11b1b9aaa35', 'created', '2026-09-27 06:47:04.125+09', '{"type": "system"}', 'tenant-a の記憶 18 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3b1fd5ea-5d80-4244-b235-4006d046c621"}');
INSERT INTO public.memory_events VALUES ('10e3f42e-c6ea-4618-89a8-3237c57d790d', 'tenant-a', '6eb13a38-d170-4dde-a76e-abcd9787bd78', 'created', '2026-09-27 06:47:04.136+09', '{"type": "system"}', 'tenant-a の記憶 19 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "83fe7622-1fe7-4011-a8bc-61fc37fbb9bd"}');
INSERT INTO public.memory_events VALUES ('a1b29f95-fbde-4b9a-a680-6ef6779d2e07', 'tenant-a', '7fcf19ee-0459-4cd2-aafa-5e8f461a1b01', 'created', '2026-09-27 06:47:04.153+09', '{"type": "system"}', 'tenant-a の記憶 20 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8a076f36-f6f5-459b-8cdd-6a7350c02812"}');
INSERT INTO public.memory_events VALUES ('92585b5f-17a4-4308-b223-cacd19e6ba7e', 'tenant-a', '0835061e-e52f-43b1-b7ce-dc9f24f015d7', 'created', '2026-09-27 06:47:04.188+09', '{"type": "system"}', 'tenant-a の記憶 21 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f35ea97a-39f7-4ad5-b887-f0e2ac32e409"}');
INSERT INTO public.memory_events VALUES ('1b60968f-27f6-4c3f-873c-296c8481e072', 'tenant-a', 'aa907ddf-3b5d-400e-b915-c43a6f7af18e', 'created', '2026-09-27 06:47:04.198+09', '{"type": "system"}', 'tenant-a の記憶 22 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e51bef24-8059-44d7-9e2c-a82635181928"}');
INSERT INTO public.memory_events VALUES ('e1f42ff4-4232-4190-afc3-520924194900', 'tenant-a', 'be6f5c44-8a10-4240-aa12-7bda7fab6b5c', 'created', '2026-09-27 06:47:04.207+09', '{"type": "system"}', 'tenant-a の記憶 23 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e19224d6-a26c-4fa0-8131-fef711f8edf4"}');
INSERT INTO public.memory_events VALUES ('9c22bcb9-f123-4f26-b708-eae3af8b8cda', 'tenant-a', '750c1584-6606-4c4a-b1c3-18011d4271da', 'created', '2026-09-27 06:47:04.239+09', '{"type": "system"}', 'tenant-a FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "bd3a67ce-1076-4e6b-ab88-942e0c756025"}');
INSERT INTO public.memory_events VALUES ('c17264a8-cbca-465e-851c-e863907e93ae', 'tenant-a', '36a018b7-2baa-4cb8-8ab4-090c046e3e96', 'created', '2026-09-27 06:47:04.445+09', '{"type": "system"}', 'tenant-a 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "045bdbaf-c42f-4cab-af0b-c928bdfc8dd0"}');
INSERT INTO public.memory_events VALUES ('532d9976-dc65-4d9b-84b1-8946a706b2df', 'tenant-a', 'a2ee63d6-f330-42aa-a2ab-fd96a7562c31', 'created', '2026-09-27 06:47:04.453+09', '{"type": "system"}', 'tenant-a 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "810efc55-c962-41ac-8351-99e5945d0869"}');
INSERT INTO public.memory_events VALUES ('abf57760-79d0-4177-a600-53efcf7dbe4b', 'tenant-a', 'b2035fac-a734-43ba-b5cc-f10c27817910', 'created', '2026-09-27 06:47:04.486+09', '{"type": "system"}', 'tenant-a 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a5291402-6f6c-47eb-9650-6c2acf2ef3a5"}');
INSERT INTO public.memory_events VALUES ('31335464-73e7-494d-9b5d-f11378980574', 'tenant-a', '3eaafd2a-7b9d-4528-a456-aefa9334dced', 'updated', '2026-09-27 06:47:04.505+09', '{"type": "system"}', 'tenant-a の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('3b120ea8-926c-479d-87e4-d9b5a23a6653', 'tenant-a', '832a490f-cf53-43db-b433-359c0ce7c5b3', 'updated', '2026-09-27 06:47:04.506+09', '{"type": "system"}', 'tenant-a の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('01a7736f-e8dd-471e-97d1-dfb4519588e5', 'tenant-a', '68a58abd-6862-4aa9-bcc7-dfd9da2ee2e1', 'forgotten', '2026-09-27 06:47:04.51+09', '{"type": "system"}', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('c6303f38-f046-4ad9-bbcc-e44bb6641b5a', 'tenant-a', 'ac5caf3f-e553-4536-b5cd-e6116d2e9dc4', 'forgotten', '2026-09-27 06:47:04.512+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('42bcae46-d47c-425b-a7da-ed8fc7341a92', 'tenant-a', 'ac5caf3f-e553-4536-b5cd-e6116d2e9dc4', 'purged', '2026-09-27 06:47:04.536+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('90ff57f7-61c0-4167-b5d1-c47dbe203e93', 'tenant-b', '17bbbe8b-48ca-477d-9f23-ee0824a28178', 'created', '2026-09-27 06:47:04.586+09', '{"type": "system"}', 'tenant-b の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9e54e7f6-35ce-4678-b590-32302e50456b"}');
INSERT INTO public.memory_events VALUES ('ae4d951c-f993-4cf9-ac56-5cd9b13834d2', 'tenant-b', '05339903-a1c8-4d2e-9ab2-b5076861c246', 'created', '2026-09-27 06:47:04.616+09', '{"type": "system"}', 'tenant-b の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "76c3d7a7-4581-4814-9bb4-878b5cf248b3"}');
INSERT INTO public.memory_events VALUES ('339a3cec-8b01-448d-9293-4d08a85c152a', 'tenant-b', '655eec4c-c86e-4e79-a9c6-272dd91956ae', 'created', '2026-09-27 06:47:04.626+09', '{"type": "system"}', 'tenant-b の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "177de721-aab2-42fa-b864-37dafe3272c3"}');
INSERT INTO public.memory_events VALUES ('ea96dd6c-0ae4-46e3-ab9d-5131f53c0bc4', 'tenant-b', '70d9d481-0c24-419d-8b8c-9c799ae20937', 'created', '2026-09-27 06:47:04.635+09', '{"type": "system"}', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6f659e44-a05b-4d48-9cef-fb48313ec4b9"}');
INSERT INTO public.memory_events VALUES ('2c9ee08a-c0bd-4937-9641-addd276ac250', 'tenant-b', '4ca5d6d2-6b8c-4a0b-8970-f8589e4af8f3', 'created', '2026-09-27 06:47:04.642+09', '{"type": "system"}', 'tenant-b の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ddafa6bf-1bdc-4798-a4d3-3eb97e5c654b"}');
INSERT INTO public.memory_events VALUES ('7607ed3c-ca97-41f7-99cf-572d9c8694ac', 'tenant-b', 'b9d95781-0306-4f16-970b-a6407dbf43d5', 'created', '2026-09-27 06:47:04.65+09', '{"type": "system"}', 'tenant-b の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e293009b-c565-41a2-8250-73b7900e14c0"}');
INSERT INTO public.memory_events VALUES ('a62ebc2b-4f8e-4542-ad36-40031c33e953', 'tenant-b', '290d95d6-4c0b-4562-988d-b823f1cd16a6', 'created', '2026-09-27 06:47:04.657+09', '{"type": "system"}', 'tenant-b の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8c7c0941-2135-41b6-911a-7bef9e538330"}');
INSERT INTO public.memory_events VALUES ('8410f118-c43f-4915-b893-1e79f028dcdb', 'tenant-b', '77f282a1-d45c-4f7e-b003-a80deaa55028', 'created', '2026-09-27 06:47:04.663+09', '{"type": "system"}', 'tenant-b の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "4b4fce0d-e028-4459-ac60-fb1a7a20a2ef"}');
INSERT INTO public.memory_events VALUES ('70e9f6d6-2312-4d22-bbfd-a8496d220034', 'tenant-b', 'd9794124-d2d6-445d-9d43-a489e11c12d3', 'created', '2026-09-27 06:47:04.697+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "29a5998c-465a-4df5-a3b3-57042fb3956f"}');
INSERT INTO public.memory_events VALUES ('ce6954be-c685-46ed-a330-5a1f60640070', 'tenant-b', 'f0425304-d570-4912-a232-e76f59b1641a', 'created', '2026-09-27 06:47:04.707+09', '{"type": "system"}', 'tenant-b の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "4076cbc1-1e4f-405c-ae37-518fcbfc94ff"}');
INSERT INTO public.memory_events VALUES ('b9545fba-4529-4c75-b7aa-ad9992b13cf4', 'tenant-b', '37d9404a-ea7c-4588-99c9-8f76243a8c4d', 'created', '2026-09-27 06:47:04.717+09', '{"type": "system"}', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8a07f665-e2b2-4b97-9311-5aa2a3601482"}');
INSERT INTO public.memory_events VALUES ('1b5ff493-2edd-4033-a8fa-9741a81201a9', 'tenant-b', '085702e3-9122-4924-b3b6-a2aba20b3c50', 'created', '2026-09-27 06:47:04.723+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e914f4e2-a1e6-4c22-814e-af8b1d0c5ed6"}');
INSERT INTO public.memory_events VALUES ('34d2ad87-c6ea-46e0-8158-3c515e8039a4', 'tenant-b', 'ac7309cc-d0ce-4b13-83f4-94685cc6c8b7', 'created', '2026-09-27 06:47:04.73+09', '{"type": "system"}', 'tenant-b の記憶 12 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "975dd48d-d7ea-44d1-888e-6d25332c0b71"}');
INSERT INTO public.memory_events VALUES ('e7bb646d-a9c9-4b11-8d4c-a6425238802f', 'tenant-b', '457bce5f-e77d-4b92-8d18-e37d9f632477', 'created', '2026-09-27 06:47:04.736+09', '{"type": "system"}', 'tenant-b の記憶 13 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2d27c2d7-31df-44b8-9559-37a9839a1780"}');
INSERT INTO public.memory_events VALUES ('914e024d-9c04-4eec-bec8-fb823f58624a', 'tenant-b', '6b663b08-a3b9-47c1-877f-437136fab799', 'created', '2026-09-27 06:47:04.762+09', '{"type": "system"}', 'tenant-b の記憶 14 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6e7fa68b-f899-4b06-80d4-a81cfb51cd85"}');
INSERT INTO public.memory_events VALUES ('3e5f3215-8020-44f8-8a5f-8c7eb689a91c', 'tenant-b', '16ac3149-2d51-4a65-8d1e-9fb359eab713', 'created', '2026-09-27 06:47:04.775+09', '{"type": "system"}', 'tenant-b の記憶 15 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "334f7a38-7f81-434b-80cc-a5d0dc92e506"}');
INSERT INTO public.memory_events VALUES ('64e24985-3736-44f5-813d-fe767e32a6d1', 'tenant-b', '5e63de98-905a-4fb3-8e65-45bd5c514b3c', 'created', '2026-09-27 06:47:04.781+09', '{"type": "system"}', 'tenant-b の記憶 16 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9e5082da-ac08-4c9b-a292-704def191716"}');
INSERT INTO public.memory_events VALUES ('cedffddd-408d-4e8c-96f8-e27786bcbf64', 'tenant-b', '84a40b66-54af-4eea-9777-4b7c47a2ec64', 'created', '2026-09-27 06:47:04.786+09', '{"type": "system"}', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3628f18e-b9ef-4ba8-ad24-8b547af5649a"}');
INSERT INTO public.memory_events VALUES ('b203be2e-c01b-4b95-9107-d22ebb6241d1', 'tenant-b', '492cdfac-fada-43de-9cde-ca890ec1f88d', 'created', '2026-09-27 06:47:04.792+09', '{"type": "system"}', 'tenant-b FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "15956ed8-d1dd-4ebd-94fd-cddabc9da6bd"}');
INSERT INTO public.memory_events VALUES ('f29271b7-278c-4c1a-b53d-709d0f20e940', 'tenant-b', '7764b9f6-9eb7-4370-bfca-1197c5964425', 'created', '2026-09-27 06:47:04.934+09', '{"type": "system"}', 'tenant-b 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d765d976-65b6-47cb-91a8-d13349544725"}');
INSERT INTO public.memory_events VALUES ('5632092f-aff4-4339-a0bf-cc03d727b231', 'tenant-b', '2c995ff0-846b-470b-9d57-7d41ba1e4e25', 'created', '2026-09-27 06:47:04.942+09', '{"type": "system"}', 'tenant-b 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ca3c6a0e-fe92-4d6a-aed7-9d2e338c043d"}');
INSERT INTO public.memory_events VALUES ('8473900b-648b-4bf5-95b6-6862aae91c55', 'tenant-b', '65dcf125-5efb-4566-9735-57d445b78547', 'created', '2026-09-27 06:47:04.969+09', '{"type": "system"}', 'tenant-b 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2a05c925-c5a3-4090-a896-d53d2bdebcce"}');
INSERT INTO public.memory_events VALUES ('cd27eacc-f474-4f4e-9328-33bd487d4873', 'tenant-b', '290d95d6-4c0b-4562-988d-b823f1cd16a6', 'updated', '2026-09-27 06:47:04.979+09', '{"type": "system"}', 'tenant-b の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('80f9d0a6-0295-45d6-b0c6-19b7e0fa9c3f', 'tenant-b', 'd9794124-d2d6-445d-9d43-a489e11c12d3', 'updated', '2026-09-27 06:47:04.979+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('998dc757-0a77-4c41-97c4-f1c8cf901797', 'tenant-b', '37d9404a-ea7c-4588-99c9-8f76243a8c4d', 'forgotten', '2026-09-27 06:47:04.984+09', '{"type": "system"}', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('933cede7-2293-4d39-9560-7044f006fca9', 'tenant-b', '085702e3-9122-4924-b3b6-a2aba20b3c50', 'forgotten', '2026-09-27 06:47:04.987+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('9ac77d29-78b6-4f94-b768-dd34b30d0131', 'tenant-b', '085702e3-9122-4924-b3b6-a2aba20b3c50', 'purged', '2026-09-27 06:47:04.989+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('c3748a7a-7452-4823-bfff-7fa89bae0c11', 'tenant-b', 'd9794124-d2d6-445d-9d43-a489e11c12d3', 'forgotten', '2026-09-27 06:47:04.993+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "fixture: orphaned contested"}');
INSERT INTO public.memory_events VALUES ('71dbdf11-895b-4337-a565-d570be73a8e8', 'tenant-c', 'f74f1a5e-9254-4da2-b201-793f4a707663', 'created', '2026-09-27 06:47:05.036+09', '{"type": "system"}', 'tenant-c の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "40f8d001-aa71-4262-ade3-b9352dc73ca3"}');
INSERT INTO public.memory_events VALUES ('04fafda0-6b4e-458d-8624-2d60079c9ccd', 'tenant-c', '1b9b19b9-a36c-42f6-ad73-dd1be3956fd1', 'created', '2026-09-27 06:47:05.045+09', '{"type": "system"}', 'tenant-c の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d7d347fc-8855-49d0-a4ef-f42ca820c487"}');
INSERT INTO public.memory_events VALUES ('2160a4a3-6818-49e2-b0d6-096805381b87', 'tenant-c', 'c423022b-93bf-40d5-a507-6430f41caba8', 'created', '2026-09-27 06:47:05.055+09', '{"type": "system"}', 'tenant-c の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "efeb5cbd-7b75-4e52-94a7-e01bc2980a6e"}');
INSERT INTO public.memory_events VALUES ('8f32ee95-709d-42b8-af71-a301b123d4a6', 'tenant-c', 'bf117f84-8fef-4dba-ad41-516b81ce1649', 'created', '2026-09-27 06:47:05.091+09', '{"type": "system"}', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "96dff28e-bb33-4a79-adab-f2aa8fad7c11"}');
INSERT INTO public.memory_events VALUES ('c0770086-dd0b-4332-8098-491e8d71251b', 'tenant-c', '7c807ea0-c1dc-4b65-8123-411e0325f5ce', 'created', '2026-09-27 06:47:05.1+09', '{"type": "system"}', 'tenant-c の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d39d6580-3b30-4c25-9b7a-82ecc090f4bd"}');
INSERT INTO public.memory_events VALUES ('bc764654-7d65-4952-8d51-9f7d6156aabd', 'tenant-c', 'eaf39e64-e7e9-4642-aa6b-e415f7bcfb1a', 'created', '2026-09-27 06:47:05.106+09', '{"type": "system"}', 'tenant-c の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f7ffa030-0e96-43dd-8b54-1289a7d5f466"}');
INSERT INTO public.memory_events VALUES ('4edbd618-df40-4c99-8ff4-cea862e9f524', 'tenant-c', 'b05cf74d-9056-48d6-a7c3-fe9f92fe311a', 'created', '2026-09-27 06:47:05.136+09', '{"type": "system"}', 'tenant-c の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "bfee10e5-f991-45c6-a6e2-5d73b8587728"}');
INSERT INTO public.memory_events VALUES ('852ef59f-8a5f-40aa-9c23-47e8dd4f50ea', 'tenant-c', '10563ca6-bc9c-48ba-9f6c-405444cfc9cb', 'created', '2026-09-27 06:47:05.144+09', '{"type": "system"}', 'tenant-c の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "65414fe2-78c3-46ed-b0e4-f6ee55e408c5"}');
INSERT INTO public.memory_events VALUES ('cbb1d1d6-26e0-49ea-9abd-981699a4e9ae', 'tenant-c', '78a6562a-224a-4cdc-a0ec-a01f70aa92f8', 'created', '2026-09-27 06:47:05.15+09', '{"type": "system"}', 'tenant-c の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f1e670f7-fd06-4da5-8d85-b1991c437e3b"}');
INSERT INTO public.memory_events VALUES ('a61677ca-b4f9-4639-b1db-4fbd13bf3351', 'tenant-c', '1b0ed14f-9100-45fb-9a56-46163fd46ff5', 'created', '2026-09-27 06:47:05.157+09', '{"type": "system"}', 'tenant-c の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d18558a0-d1e2-4cff-ab59-9a3dbfc90e65"}');
INSERT INTO public.memory_events VALUES ('f9dd6096-d143-4dd3-b2b3-a61b90fd208f', 'tenant-c', 'cb6047fc-1d5d-4f42-b4a1-0869ab8c01d1', 'created', '2026-09-27 06:47:05.165+09', '{"type": "system"}', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b33e68b1-f572-4b3a-a99d-0296c22594ce"}');
INSERT INTO public.memory_events VALUES ('435b8f0c-e7bf-4e6a-bb8d-9cd62eb6292b', 'tenant-c', 'eabc19c0-408b-4906-9c0b-c4cc03590564', 'created', '2026-09-27 06:47:05.207+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c113d9b0-f9a4-4959-a843-8596f8121a3a"}');
INSERT INTO public.memory_events VALUES ('a7cbe1bc-bcf4-4c5b-b1c7-6f36fcd0c699', 'tenant-c', '27c504ea-4489-41ee-b6a0-d402b449ee6f', 'created', '2026-09-27 06:47:05.215+09', '{"type": "system"}', 'tenant-c FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d8b322fb-02ba-4c39-928f-2a7a4f3d0ad7"}');
INSERT INTO public.memory_events VALUES ('98e92c4d-4c52-4780-a278-aea3c4dc65bb', 'tenant-c', '6e9d888c-c626-474d-900c-29ddbef80fef', 'created', '2026-09-27 06:47:05.336+09', '{"type": "system"}', 'tenant-c 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f5c401fb-6edd-48c4-ba8b-46af5621c7bb"}');
INSERT INTO public.memory_events VALUES ('8816c795-8ebf-41e1-bb8e-8f36abb70868', 'tenant-c', '1ec5034e-fd0e-4d63-bd8f-26843d448006', 'created', '2026-09-27 06:47:05.344+09', '{"type": "system"}', 'tenant-c 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8eeada59-c215-444f-9097-97eb675ddaa0"}');
INSERT INTO public.memory_events VALUES ('2919619f-6ff0-4a86-867d-02f648df25d5', 'tenant-c', 'faa17efc-d683-42fe-bc28-4720ea837a52', 'created', '2026-09-27 06:47:05.36+09', '{"type": "system"}', 'tenant-c 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e40adc96-c6a2-439a-8743-d9483aab7020"}');
INSERT INTO public.memory_events VALUES ('38084888-93f1-4787-907c-d3a8ced35657', 'tenant-c', 'b05cf74d-9056-48d6-a7c3-fe9f92fe311a', 'updated', '2026-09-27 06:47:05.395+09', '{"type": "system"}', 'tenant-c の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('78fae5d8-95b0-4f07-b9f0-9d8b34d2920d', 'tenant-c', '78a6562a-224a-4cdc-a0ec-a01f70aa92f8', 'updated', '2026-09-27 06:47:05.395+09', '{"type": "system"}', 'tenant-c の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('efe1c008-612c-4b71-b020-46ac802ee373', 'tenant-c', 'cb6047fc-1d5d-4f42-b4a1-0869ab8c01d1', 'forgotten', '2026-09-27 06:47:05.4+09', '{"type": "system"}', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('22358e4e-227b-46f5-92d7-5dac4c4afbb0', 'tenant-c', 'eabc19c0-408b-4906-9c0b-c4cc03590564', 'forgotten', '2026-09-27 06:47:05.403+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('76e13bed-c772-4845-a51b-d961279ec6f6', 'tenant-c', 'eabc19c0-408b-4906-9c0b-c4cc03590564', 'purged', '2026-09-27 06:47:05.406+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('1636bd4f-60ae-4e98-8630-5d7115ed68b8', 'tenant-c', 'eaf39e64-e7e9-4642-aa6b-e415f7bcfb1a', 'forgotten', '2026-09-27 06:47:05.41+09', '{"type": "system"}', 'tenant-c の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "fixture: successor forgotten"}');
INSERT INTO public.memory_events VALUES ('15d85c38-67d9-4c37-8219-a529b43cbab2', 'tenant-a2', 'c2cbb566-6b1c-40b0-8091-b7eb4723754a', 'created', '2026-09-27 06:47:05.427+09', '{"type": "system"}', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "73796916-1502-4964-8d5e-2695e7bc3d3b"}');
INSERT INTO public.memory_events VALUES ('2ce9bbee-e70a-4f08-bc32-4a338b270a3d', 'tenant-a2', '24540d97-3daa-4014-9128-0819f6fba9db', 'created', '2026-09-27 06:47:05.456+09', '{"type": "system"}', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "233db03d-a4af-4937-b018-5e849d6f5473"}');
INSERT INTO public.memory_events VALUES ('ab519c3b-c774-49c1-a8da-35ef1aad6c5d', 'tenant-a2', '7a31e516-db8c-4770-bef1-636a6939e8ce', 'created', '2026-09-27 06:47:05.468+09', '{"type": "system"}', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b0e496ff-7ca1-4b31-929d-632cbb5b810e"}');
INSERT INTO public.memory_events VALUES ('dd7b53a0-cc24-4888-aa85-51ff2803d72e', 'tenant-a2', '58208bdb-901d-4dbb-bb18-191dca147cad', 'created', '2026-09-27 06:47:05.473+09', '{"type": "system"}', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a6a8e7f1-0b79-414e-a622-bbc2eff6de18"}');
INSERT INTO public.memory_events VALUES ('89fc284b-c084-48ca-9af5-617c4a0b768d', 'tenant-a2', 'bc45305e-f66b-4259-87fc-7e95d0aaf321', 'created', '2026-09-27 06:47:05.48+09', '{"type": "system"}', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "aad7e883-200b-42cc-a26f-f04e84072157"}');
INSERT INTO public.memory_events VALUES ('bf307f9c-e1d7-40be-b0f0-3d3acd11c950', 'tenant-a2', '78d7dd8f-9d66-44e9-b0f6-e12e21fa9701', 'created', '2026-09-27 06:47:05.488+09', '{"type": "system"}', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "138d04b2-1698-46bd-801e-73d94ba8ef47"}');
INSERT INTO public.memory_events VALUES ('56658c19-4f88-48dc-8ff6-dc0cce7bbe69', 'tenant-a2', 'de88d53a-db55-4df4-a95e-13076083d22f', 'created', '2026-09-27 06:47:05.493+09', '{"type": "system"}', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0ce2d2e7-0409-4de0-836a-c87fae1cccf1"}');
INSERT INTO public.memory_events VALUES ('e0786178-659b-417b-8b7d-1282ee787035', 'tenant-a2', '663d79c0-8de7-4b0d-8b9e-161a947bc954', 'created', '2026-09-27 06:47:05.497+09', '{"type": "system"}', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "67606c7e-a4aa-4ea3-9d3b-609d7b2bea60"}');
INSERT INTO public.memory_events VALUES ('03594121-e35a-41a2-be59-5ca581d1a584', 'tenant-a2', '71a462b3-bbbd-4382-9bc3-6f02244ea4ed', 'created', '2026-09-27 06:47:05.503+09', '{"type": "system"}', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d4daa1df-c124-447c-8d28-b2e87dde68af"}');
INSERT INTO public.memory_events VALUES ('4e353f57-d1fe-4b06-a944-a93d9b4d60b8', 'tenant-a2', 'b41b86fd-7f83-43c4-8230-de53e8cf2435', 'created', '2026-09-27 06:47:05.508+09', '{"type": "system"}', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "39cdbcfd-181b-4dcd-9dee-6177061a8998"}');
INSERT INTO public.memory_events VALUES ('55653f3a-f7eb-47cb-b0b5-cc07b5280117', 'tenant-a2', 'e5e2ff1e-c44c-413d-8396-e93c413c983d', 'created', '2026-09-27 06:47:05.53+09', '{"type": "system"}', 'tenant-a2 FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0c4dd196-352a-4ac8-9780-92a9f7e415a0"}');
INSERT INTO public.memory_events VALUES ('b0cdd5af-7466-43d7-9cbc-4db589198a3a', 'tenant-a2', '36927efd-7c78-4194-b1d8-ef20806185a0', 'created', '2026-09-27 06:47:05.605+09', '{"type": "system"}', 'tenant-a2 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0c15739e-1b43-4d52-9b78-945486a3165d"}');
INSERT INTO public.memory_events VALUES ('081958e0-2b92-402a-8f9a-4df07c9b67bf', 'tenant-a2', '85ffcbdc-c509-4a19-b40f-b20701b86538', 'created', '2026-09-27 06:47:05.612+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "113280e5-d14c-4d3c-b34a-717ac73f530b"}');
INSERT INTO public.memory_events VALUES ('f76cfa0d-63a1-4681-92d0-c4df6f54df0a', 'tenant-a2', 'ad7bdf2d-6509-4805-958f-f5a36bb2cbd2', 'created', '2026-09-27 06:47:05.618+09', '{"type": "system"}', 'tenant-a2 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3f2110c9-4c4e-4ead-9730-8c6c547dd03f"}');
INSERT INTO public.memory_events VALUES ('35d4b4eb-f8ac-461a-bdab-479e9e244ce0', 'tenant-a2', 'de88d53a-db55-4df4-a95e-13076083d22f', 'updated', '2026-09-27 06:47:05.626+09', '{"type": "system"}', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('ed277c39-6529-47fa-a986-3ef898fad2ce', 'tenant-a2', '71a462b3-bbbd-4382-9bc3-6f02244ea4ed', 'updated', '2026-09-27 06:47:05.626+09', '{"type": "system"}', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('042c49d7-d3bb-46e0-8558-7ca30a32af81', 'tenant-a2', '36927efd-7c78-4194-b1d8-ef20806185a0', 'forgotten', '2026-09-27 06:47:05.629+09', '{"type": "system"}', 'tenant-a2 未埋め込み 0', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('07649730-b2e4-4ebe-8a68-d4ee0d3901dd', 'tenant-a2', '85ffcbdc-c509-4a19-b40f-b20701b86538', 'forgotten', '2026-09-27 06:47:05.632+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('5e490a90-7667-48fe-acb2-5510de8717b1', 'tenant-a2', '85ffcbdc-c509-4a19-b40f-b20701b86538', 'purged', '2026-09-27 06:47:05.635+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "fixture"}');


--
-- Data for Name: memory_labels; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: observations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.observations VALUES ('88e63a9f-c033-4042-a7ca-2746552d8f17', 'tenant-a', NULL, 'tenant-a-ext-0', 'utterance', '{"text": "tenant-a の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 06:47:03.793+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ca660e37-00af-4c76-a5b2-d3b55ea0dbf0', 'tenant-a', NULL, 'tenant-a-ext-1', 'utterance', '{"text": "tenant-a の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:03.838+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('97b1cb39-ed27-4860-8f6d-94d3d59d1728', 'tenant-a', NULL, 'tenant-a-ext-2', 'utterance', '{"text": "tenant-a の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 06:47:03.85+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f4f0f0cc-7f0a-410c-936b-c5dedca34fff', 'tenant-a', NULL, 'tenant-a-ext-3', 'utterance', '{"text": "tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-27 06:47:03.861+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('aad771dc-afed-4aa9-8ac6-985e4c45c404', 'tenant-a', NULL, 'tenant-a-ext-4', 'utterance', '{"text": "tenant-a の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 06:47:03.894+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('785e607b-09f8-465a-8360-66b6da12655e', 'tenant-a', NULL, 'tenant-a-ext-5', 'utterance', '{"text": "tenant-a の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 06:47:03.906+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('81b6f047-c32a-4faa-81e7-4c43558bfd27', 'tenant-a', NULL, 'tenant-a-ext-6', 'utterance', '{"text": "tenant-a の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:03.915+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8a26664b-d83b-4747-8935-fec286b87004', 'tenant-a', NULL, 'tenant-a-ext-7', 'utterance', '{"text": "tenant-a の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 06:47:03.951+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('169fe4f9-d83c-4bc1-a26c-35c910a04966', 'tenant-a', NULL, 'tenant-a-ext-8', 'utterance', '{"text": "tenant-a の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 06:47:03.962+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a661af1a-d001-48f9-bff4-af207f5001d3', 'tenant-a', NULL, 'tenant-a-ext-9', 'utterance', '{"text": "tenant-a の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 06:47:03.971+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('82624b0d-d622-46d0-9166-4d45fb812afb', 'tenant-a', NULL, 'tenant-a-ext-10', 'utterance', '{"text": "tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-09-27 06:47:03.978+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('887696e5-5955-43c0-bd1c-9cd409050c81', 'tenant-a', NULL, 'tenant-a-ext-11', 'utterance', '{"text": "tenant-a の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:03.985+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('593b2561-9ea2-4d11-8ea1-3342a5901237', 'tenant-a', NULL, 'tenant-a-ext-12', 'utterance', '{"text": "tenant-a の記憶 12 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 06:47:04.011+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('50e57e74-0821-4d8b-b7c2-7cfddb065ad5', 'tenant-a', NULL, 'tenant-a-ext-13', 'utterance', '{"text": "tenant-a の記憶 13 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 06:47:04.022+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c8ac7390-3252-4f06-be88-830e09f53d68', 'tenant-a', NULL, 'tenant-a-ext-14', 'utterance', '{"text": "tenant-a の記憶 14 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 06:47:04.032+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('565d53f9-614f-428c-a8a5-0ba159bef3cc', 'tenant-a', NULL, 'tenant-a-ext-15', 'utterance', '{"text": "tenant-a の記憶 15 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 06:47:04.044+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f066493f-c21b-4702-bc4a-ecf3191fe193', 'tenant-a', NULL, 'tenant-a-ext-16', 'utterance', '{"text": "tenant-a の記憶 16 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:04.075+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6ffd3b77-de42-4b81-afe0-9b7da404308b', 'tenant-a', NULL, 'tenant-a-ext-17', 'utterance', '{"text": "tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO", "speaker": "user"}', NULL, '2026-09-27 06:47:04.088+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('3b1fd5ea-5d80-4244-b235-4006d046c621', 'tenant-a', NULL, 'tenant-a-ext-18', 'utterance', '{"text": "tenant-a の記憶 18 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 06:47:04.098+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('83fe7622-1fe7-4011-a8bc-61fc37fbb9bd', 'tenant-a', NULL, 'tenant-a-ext-19', 'utterance', '{"text": "tenant-a の記憶 19 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 06:47:04.13+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8a076f36-f6f5-459b-8cdd-6a7350c02812', 'tenant-a', NULL, 'tenant-a-ext-20', 'utterance', '{"text": "tenant-a の記憶 20 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 06:47:04.139+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f35ea97a-39f7-4ad5-b887-f0e2ac32e409', 'tenant-a', NULL, 'tenant-a-ext-21', 'utterance', '{"text": "tenant-a の記憶 21 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:04.155+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e51bef24-8059-44d7-9e2c-a82635181928', 'tenant-a', NULL, 'tenant-a-ext-22', 'utterance', '{"text": "tenant-a の記憶 22 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 06:47:04.191+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e19224d6-a26c-4fa0-8131-fef711f8edf4', 'tenant-a', NULL, 'tenant-a-ext-23', 'utterance', '{"text": "tenant-a の記憶 23 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 06:47:04.2+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('bd3a67ce-1076-4e6b-ab88-942e0c756025', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-27 06:47:04.21+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('045bdbaf-c42f-4cab-af0b-c928bdfc8dd0', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-27 06:47:04.44+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('810efc55-c962-41ac-8351-99e5945d0869', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-27 06:47:04.447+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a5291402-6f6c-47eb-9650-6c2acf2ef3a5', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-27 06:47:04.477+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f296f75b-f281-45dc-91e8-280a3b95b9f9', 'tenant-a', NULL, NULL, 'usage', '{"recallId": "0e363499-072d-409c-9dab-589d2e6aaa21", "usedMemoryIds": ["7fcf19ee-0459-4cd2-aafa-5e8f461a1b01"]}', NULL, '2026-09-27 06:47:04.572+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9e54e7f6-35ce-4678-b590-32302e50456b', 'tenant-b', NULL, 'tenant-b-ext-0', 'utterance', '{"text": "tenant-b の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 06:47:04.579+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('76c3d7a7-4581-4814-9bb4-878b5cf248b3', 'tenant-b', NULL, 'tenant-b-ext-1', 'utterance', '{"text": "tenant-b の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:04.588+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('177de721-aab2-42fa-b864-37dafe3272c3', 'tenant-b', NULL, 'tenant-b-ext-2', 'utterance', '{"text": "tenant-b の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 06:47:04.618+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6f659e44-a05b-4d48-9cef-fb48313ec4b9', 'tenant-b', NULL, 'tenant-b-ext-3', 'utterance', '{"text": "tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-27 06:47:04.629+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ddafa6bf-1bdc-4798-a4d3-3eb97e5c654b', 'tenant-b', NULL, 'tenant-b-ext-4', 'utterance', '{"text": "tenant-b の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 06:47:04.637+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e293009b-c565-41a2-8250-73b7900e14c0', 'tenant-b', NULL, 'tenant-b-ext-5', 'utterance', '{"text": "tenant-b の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 06:47:04.643+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8c7c0941-2135-41b6-911a-7bef9e538330', 'tenant-b', NULL, 'tenant-b-ext-6', 'utterance', '{"text": "tenant-b の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:04.652+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('4b4fce0d-e028-4459-ac60-fb1a7a20a2ef', 'tenant-b', NULL, 'tenant-b-ext-7', 'utterance', '{"text": "tenant-b の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 06:47:04.658+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('29a5998c-465a-4df5-a3b3-57042fb3956f', 'tenant-b', NULL, 'tenant-b-ext-8', 'utterance', '{"text": "tenant-b の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 06:47:04.665+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('4076cbc1-1e4f-405c-ae37-518fcbfc94ff', 'tenant-b', NULL, 'tenant-b-ext-9', 'utterance', '{"text": "tenant-b の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 06:47:04.701+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8a07f665-e2b2-4b97-9311-5aa2a3601482', 'tenant-b', NULL, 'tenant-b-ext-10', 'utterance', '{"text": "tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-09-27 06:47:04.711+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e914f4e2-a1e6-4c22-814e-af8b1d0c5ed6', 'tenant-b', NULL, 'tenant-b-ext-11', 'utterance', '{"text": "tenant-b の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:04.719+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('975dd48d-d7ea-44d1-888e-6d25332c0b71', 'tenant-b', NULL, 'tenant-b-ext-12', 'utterance', '{"text": "tenant-b の記憶 12 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 06:47:04.725+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('2d27c2d7-31df-44b8-9559-37a9839a1780', 'tenant-b', NULL, 'tenant-b-ext-13', 'utterance', '{"text": "tenant-b の記憶 13 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 06:47:04.731+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6e7fa68b-f899-4b06-80d4-a81cfb51cd85', 'tenant-b', NULL, 'tenant-b-ext-14', 'utterance', '{"text": "tenant-b の記憶 14 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 06:47:04.737+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('334f7a38-7f81-434b-80cc-a5d0dc92e506', 'tenant-b', NULL, 'tenant-b-ext-15', 'utterance', '{"text": "tenant-b の記憶 15 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 06:47:04.766+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9e5082da-ac08-4c9b-a292-704def191716', 'tenant-b', NULL, 'tenant-b-ext-16', 'utterance', '{"text": "tenant-b の記憶 16 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:04.777+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('3628f18e-b9ef-4ba8-ad24-8b547af5649a', 'tenant-b', NULL, 'tenant-b-ext-17', 'utterance', '{"text": "tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO", "speaker": "user"}', NULL, '2026-09-27 06:47:04.783+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('15956ed8-d1dd-4ebd-94fd-cddabc9da6bd', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-27 06:47:04.788+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d765d976-65b6-47cb-91a8-d13349544725', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-27 06:47:04.929+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ca3c6a0e-fe92-4d6a-aed7-9d2e338c043d', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-27 06:47:04.935+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('2a05c925-c5a3-4090-a896-d53d2bdebcce', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-27 06:47:04.944+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('76fa3899-4292-4217-bd24-d2787fe80e5f', 'tenant-b', NULL, NULL, 'usage', '{"recallId": "32ab5061-34cc-42e1-8d99-4f0fac56729e", "usedMemoryIds": ["6b663b08-a3b9-47c1-877f-437136fab799"]}', NULL, '2026-09-27 06:47:05.003+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('40f8d001-aa71-4262-ade3-b9352dc73ca3', 'tenant-c', NULL, 'tenant-c-ext-0', 'utterance', '{"text": "tenant-c の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 06:47:05.031+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d7d347fc-8855-49d0-a4ef-f42ca820c487', 'tenant-c', NULL, 'tenant-c-ext-1', 'utterance', '{"text": "tenant-c の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:05.039+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('efeb5cbd-7b75-4e52-94a7-e01bc2980a6e', 'tenant-c', NULL, 'tenant-c-ext-2', 'utterance', '{"text": "tenant-c の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 06:47:05.047+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('96dff28e-bb33-4a79-adab-f2aa8fad7c11', 'tenant-c', NULL, 'tenant-c-ext-3', 'utterance', '{"text": "tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-27 06:47:05.057+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d39d6580-3b30-4c25-9b7a-82ecc090f4bd', 'tenant-c', NULL, 'tenant-c-ext-4', 'utterance', '{"text": "tenant-c の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 06:47:05.094+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f7ffa030-0e96-43dd-8b54-1289a7d5f466', 'tenant-c', NULL, 'tenant-c-ext-5', 'utterance', '{"text": "tenant-c の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 06:47:05.102+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('bfee10e5-f991-45c6-a6e2-5d73b8587728', 'tenant-c', NULL, 'tenant-c-ext-6', 'utterance', '{"text": "tenant-c の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:05.108+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('65414fe2-78c3-46ed-b0e4-f6ee55e408c5', 'tenant-c', NULL, 'tenant-c-ext-7', 'utterance', '{"text": "tenant-c の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 06:47:05.139+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f1e670f7-fd06-4da5-8d85-b1991c437e3b', 'tenant-c', NULL, 'tenant-c-ext-8', 'utterance', '{"text": "tenant-c の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 06:47:05.146+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d18558a0-d1e2-4cff-ab59-9a3dbfc90e65', 'tenant-c', NULL, 'tenant-c-ext-9', 'utterance', '{"text": "tenant-c の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 06:47:05.152+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b33e68b1-f572-4b3a-a99d-0296c22594ce', 'tenant-c', NULL, 'tenant-c-ext-10', 'utterance', '{"text": "tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-09-27 06:47:05.159+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c113d9b0-f9a4-4959-a843-8596f8121a3a', 'tenant-c', NULL, 'tenant-c-ext-11', 'utterance', '{"text": "tenant-c の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:05.199+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d8b322fb-02ba-4c39-928f-2a7a4f3d0ad7', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-27 06:47:05.209+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f5c401fb-6edd-48c4-ba8b-46af5621c7bb', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-27 06:47:05.328+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8eeada59-c215-444f-9097-97eb675ddaa0', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-27 06:47:05.339+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e40adc96-c6a2-439a-8743-d9483aab7020', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-27 06:47:05.35+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8151fb9f-0e90-41ed-9cb2-a715d485a1da', 'tenant-c', NULL, NULL, 'usage', '{"recallId": "ff67ef95-26a0-4ff6-9498-b03e1e5e89cc", "usedMemoryIds": ["c423022b-93bf-40d5-a507-6430f41caba8"]}', NULL, '2026-09-27 06:47:05.42+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('73796916-1502-4964-8d5e-2695e7bc3d3b', 'tenant-a2', NULL, 'tenant-a2-ext-0', 'utterance', '{"text": "tenant-a2 の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 06:47:05.424+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('233db03d-a4af-4937-b018-5e849d6f5473', 'tenant-a2', NULL, 'tenant-a2-ext-1', 'utterance', '{"text": "tenant-a2 の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:05.428+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b0e496ff-7ca1-4b31-929d-632cbb5b810e', 'tenant-a2', NULL, 'tenant-a2-ext-2', 'utterance', '{"text": "tenant-a2 の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 06:47:05.459+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a6a8e7f1-0b79-414e-a622-bbc2eff6de18', 'tenant-a2', NULL, 'tenant-a2-ext-3', 'utterance', '{"text": "tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-27 06:47:05.469+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('aad7e883-200b-42cc-a26f-f04e84072157', 'tenant-a2', NULL, 'tenant-a2-ext-4', 'utterance', '{"text": "tenant-a2 の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 06:47:05.475+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('138d04b2-1698-46bd-801e-73d94ba8ef47', 'tenant-a2', NULL, 'tenant-a2-ext-5', 'utterance', '{"text": "tenant-a2 の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-27 06:47:05.482+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0ce2d2e7-0409-4de0-836a-c87fae1cccf1', 'tenant-a2', NULL, 'tenant-a2-ext-6', 'utterance', '{"text": "tenant-a2 の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-27 06:47:05.489+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('67606c7e-a4aa-4ea3-9d3b-609d7b2bea60', 'tenant-a2', NULL, 'tenant-a2-ext-7', 'utterance', '{"text": "tenant-a2 の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-27 06:47:05.494+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d4daa1df-c124-447c-8d28-b2e87dde68af', 'tenant-a2', NULL, 'tenant-a2-ext-8', 'utterance', '{"text": "tenant-a2 の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-27 06:47:05.499+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('39cdbcfd-181b-4dcd-9dee-6177061a8998', 'tenant-a2', NULL, 'tenant-a2-ext-9', 'utterance', '{"text": "tenant-a2 の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-27 06:47:05.505+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0c4dd196-352a-4ac8-9780-92a9f7e415a0', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-27 06:47:05.526+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0c15739e-1b43-4d52-9b78-945486a3165d', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-27 06:47:05.6+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('113280e5-d14c-4d3c-b34a-717ac73f530b', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-27 06:47:05.607+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('3f2110c9-4c4e-4ead-9730-8c6c547dd03f', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-27 06:47:05.614+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a1f2db0b-2e6a-43bf-afe2-4e6c744d58fb', 'tenant-a2', NULL, NULL, 'usage', '{"recallId": "74800cb8-49a9-48e1-b344-e7c96e2a5ca8", "usedMemoryIds": ["7a31e516-db8c-4770-bef1-636a6939e8ce"]}', NULL, '2026-09-27 06:47:05.647+09', NULL, NULL, '{}');


--
-- Data for Name: outbox; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.outbox VALUES ('2e6c5642-8afa-473c-a295-ade826916ea6', 'tenant-a', 'extract', '{"observationId": "88e63a9f-c033-4042-a7ca-2746552d8f17"}', '2026-09-27 06:47:03.794745+09', NULL, NULL, 0, '2026-09-27 06:47:03.83707+09', NULL, NULL, '2026-09-27 06:47:03.794745+09');
INSERT INTO public.outbox VALUES ('5a6b091e-c451-4ce7-b765-6cbe04ec1b53', 'tenant-a', 'extract', '{"observationId": "ca660e37-00af-4c76-a5b2-d3b55ea0dbf0"}', '2026-09-27 06:47:03.838994+09', NULL, NULL, 0, '2026-09-27 06:47:03.849471+09', NULL, NULL, '2026-09-27 06:47:03.838994+09');
INSERT INTO public.outbox VALUES ('c9dbb555-2c09-48c5-a9b9-1d8c7695659e', 'tenant-a', 'extract', '{"observationId": "97b1cb39-ed27-4860-8f6d-94d3d59d1728"}', '2026-09-27 06:47:03.85126+09', NULL, NULL, 0, '2026-09-27 06:47:03.86108+09', NULL, NULL, '2026-09-27 06:47:03.85126+09');
INSERT INTO public.outbox VALUES ('843f19ac-fba7-495a-a26e-10a85bdb8283', 'tenant-a', 'extract', '{"observationId": "f4f0f0cc-7f0a-410c-936b-c5dedca34fff"}', '2026-09-27 06:47:03.86207+09', NULL, NULL, 0, '2026-09-27 06:47:03.892848+09', NULL, NULL, '2026-09-27 06:47:03.86207+09');
INSERT INTO public.outbox VALUES ('f9105cf5-1970-48ae-85f0-0c2a9f943657', 'tenant-a', 'extract', '{"observationId": "aad771dc-afed-4aa9-8ac6-985e4c45c404"}', '2026-09-27 06:47:03.894538+09', NULL, NULL, 0, '2026-09-27 06:47:03.905768+09', NULL, NULL, '2026-09-27 06:47:03.894538+09');
INSERT INTO public.outbox VALUES ('72069495-4318-453a-9db4-b4de28b0c916', 'tenant-a', 'extract', '{"observationId": "785e607b-09f8-465a-8360-66b6da12655e"}', '2026-09-27 06:47:03.906956+09', NULL, NULL, 0, '2026-09-27 06:47:03.914862+09', NULL, NULL, '2026-09-27 06:47:03.906956+09');
INSERT INTO public.outbox VALUES ('35026ced-4eb5-4249-b200-c2cb07d77296', 'tenant-a', 'extract', '{"observationId": "81b6f047-c32a-4faa-81e7-4c43558bfd27"}', '2026-09-27 06:47:03.915776+09', NULL, NULL, 0, '2026-09-27 06:47:03.950353+09', NULL, NULL, '2026-09-27 06:47:03.915776+09');
INSERT INTO public.outbox VALUES ('fb58acf1-23cd-4058-9ceb-3e9152274a13', 'tenant-a', 'extract', '{"observationId": "8a26664b-d83b-4747-8935-fec286b87004"}', '2026-09-27 06:47:03.951687+09', NULL, NULL, 0, '2026-09-27 06:47:03.960978+09', NULL, NULL, '2026-09-27 06:47:03.951687+09');
INSERT INTO public.outbox VALUES ('bfecb2e2-b707-4123-afa1-0c096ee8ccb1', 'tenant-a', 'extract', '{"observationId": "169fe4f9-d83c-4bc1-a26c-35c910a04966"}', '2026-09-27 06:47:03.962241+09', NULL, NULL, 0, '2026-09-27 06:47:03.97057+09', NULL, NULL, '2026-09-27 06:47:03.962241+09');
INSERT INTO public.outbox VALUES ('a6cd2987-fc26-49d0-8011-698de04ad7b9', 'tenant-a', 'extract', '{"observationId": "a661af1a-d001-48f9-bff4-af207f5001d3"}', '2026-09-27 06:47:03.971602+09', NULL, NULL, 0, '2026-09-27 06:47:03.978015+09', NULL, NULL, '2026-09-27 06:47:03.971602+09');
INSERT INTO public.outbox VALUES ('7707c5be-d714-4363-84f4-5ddee0347a10', 'tenant-a', 'extract', '{"observationId": "82624b0d-d622-46d0-9166-4d45fb812afb"}', '2026-09-27 06:47:03.978903+09', NULL, NULL, 0, '2026-09-27 06:47:03.984505+09', NULL, NULL, '2026-09-27 06:47:03.978903+09');
INSERT INTO public.outbox VALUES ('17628aea-ae48-442e-8819-b982af5df24f', 'tenant-a', 'extract', '{"observationId": "887696e5-5955-43c0-bd1c-9cd409050c81"}', '2026-09-27 06:47:03.985481+09', NULL, NULL, 0, '2026-09-27 06:47:03.992172+09', NULL, NULL, '2026-09-27 06:47:03.985481+09');
INSERT INTO public.outbox VALUES ('2545f558-a442-4a58-b612-40d0f5731979', 'tenant-a', 'extract', '{"observationId": "593b2561-9ea2-4d11-8ea1-3342a5901237"}', '2026-09-27 06:47:04.01186+09', NULL, NULL, 0, '2026-09-27 06:47:04.021674+09', NULL, NULL, '2026-09-27 06:47:04.01186+09');
INSERT INTO public.outbox VALUES ('46748b6c-83a5-4e9a-87f9-e5da677f684b', 'tenant-a', 'extract', '{"observationId": "50e57e74-0821-4d8b-b7c2-7cfddb065ad5"}', '2026-09-27 06:47:04.023084+09', NULL, NULL, 0, '2026-09-27 06:47:04.0318+09', NULL, NULL, '2026-09-27 06:47:04.023084+09');
INSERT INTO public.outbox VALUES ('2848af9d-ba48-49ab-a953-26b83c3c1e37', 'tenant-a', 'extract', '{"observationId": "c8ac7390-3252-4f06-be88-830e09f53d68"}', '2026-09-27 06:47:04.033033+09', NULL, NULL, 0, '2026-09-27 06:47:04.043318+09', NULL, NULL, '2026-09-27 06:47:04.033033+09');
INSERT INTO public.outbox VALUES ('1482017f-5ec5-4829-952d-610c5441f062', 'tenant-a', 'extract', '{"observationId": "565d53f9-614f-428c-a8a5-0ba159bef3cc"}', '2026-09-27 06:47:04.044812+09', NULL, NULL, 0, '2026-09-27 06:47:04.074238+09', NULL, NULL, '2026-09-27 06:47:04.044812+09');
INSERT INTO public.outbox VALUES ('479aade8-78fb-4333-a5dc-8118f8336d60', 'tenant-a', 'extract', '{"observationId": "f066493f-c21b-4702-bc4a-ecf3191fe193"}', '2026-09-27 06:47:04.075805+09', NULL, NULL, 0, '2026-09-27 06:47:04.086848+09', NULL, NULL, '2026-09-27 06:47:04.075805+09');
INSERT INTO public.outbox VALUES ('01119a17-d6c4-42b6-a60b-a19ead14dce0', 'tenant-a', 'extract', '{"observationId": "6ffd3b77-de42-4b81-afe0-9b7da404308b"}', '2026-09-27 06:47:04.08877+09', NULL, NULL, 0, '2026-09-27 06:47:04.096489+09', NULL, NULL, '2026-09-27 06:47:04.08877+09');
INSERT INTO public.outbox VALUES ('4a20dd4a-20e6-4175-b3eb-0eb2cb82b223', 'tenant-a', 'extract', '{"observationId": "3b1fd5ea-5d80-4244-b235-4006d046c621"}', '2026-09-27 06:47:04.116447+09', NULL, NULL, 0, '2026-09-27 06:47:04.128838+09', NULL, NULL, '2026-09-27 06:47:04.116447+09');
INSERT INTO public.outbox VALUES ('c6ff9ffd-b37d-4b9d-a6a8-939aff8b624f', 'tenant-a', 'extract', '{"observationId": "83fe7622-1fe7-4011-a8bc-61fc37fbb9bd"}', '2026-09-27 06:47:04.130338+09', NULL, NULL, 0, '2026-09-27 06:47:04.138311+09', NULL, NULL, '2026-09-27 06:47:04.130338+09');
INSERT INTO public.outbox VALUES ('3907a6ce-9bf0-436d-ad7a-bbfd7f6ec207', 'tenant-a', 'extract', '{"observationId": "8a076f36-f6f5-459b-8cdd-6a7350c02812"}', '2026-09-27 06:47:04.139215+09', NULL, NULL, 0, '2026-09-27 06:47:04.154978+09', NULL, NULL, '2026-09-27 06:47:04.139215+09');
INSERT INTO public.outbox VALUES ('3c7c6f1a-302a-4dc6-ace3-1a7459b863e2', 'tenant-a', 'extract', '{"observationId": "f35ea97a-39f7-4ad5-b887-f0e2ac32e409"}', '2026-09-27 06:47:04.155923+09', NULL, NULL, 0, '2026-09-27 06:47:04.190344+09', NULL, NULL, '2026-09-27 06:47:04.155923+09');
INSERT INTO public.outbox VALUES ('d0e1acf9-d5d0-4741-8914-9c6d83e7a9f9', 'tenant-a', 'extract', '{"observationId": "e51bef24-8059-44d7-9e2c-a82635181928"}', '2026-09-27 06:47:04.191448+09', NULL, NULL, 0, '2026-09-27 06:47:04.199881+09', NULL, NULL, '2026-09-27 06:47:04.191448+09');
INSERT INTO public.outbox VALUES ('2c4a7c63-0c2b-47bf-84a6-47f6b7a536a4', 'tenant-a', 'extract', '{"observationId": "e19224d6-a26c-4fa0-8131-fef711f8edf4"}', '2026-09-27 06:47:04.201425+09', NULL, NULL, 0, '2026-09-27 06:47:04.208882+09', NULL, NULL, '2026-09-27 06:47:04.201425+09');
INSERT INTO public.outbox VALUES ('73e2c18b-ba54-4a66-a802-4ce9f1d200a0', 'tenant-a', 'extract', '{"observationId": "bd3a67ce-1076-4e6b-ab88-942e0c756025"}', '2026-09-27 06:47:04.210345+09', NULL, NULL, 0, '2026-09-27 06:47:04.240894+09', NULL, NULL, '2026-09-27 06:47:04.210345+09');
INSERT INTO public.outbox VALUES ('72dcaf76-e77a-453b-b3c6-f43a5d723d4e', 'tenant-a', 'embed', '{"memoryId": "067e442f-f09a-4ebf-9968-33c232e62204"}', '2026-09-27 06:47:03.825419+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.253545+09', NULL, NULL, '2026-09-27 06:47:03.825419+09');
INSERT INTO public.outbox VALUES ('1fe1e140-24d4-44af-93a7-3804cf5a7d4e', 'tenant-a', 'embed', '{"memoryId": "c5019fa5-7e78-4d8d-9feb-a3cdcfc52526"}', '2026-09-27 06:47:03.843436+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.261285+09', NULL, NULL, '2026-09-27 06:47:03.843436+09');
INSERT INTO public.outbox VALUES ('e5004280-6a91-48ab-928c-901bf9d98943', 'tenant-a', 'embed', '{"memoryId": "4524e767-7d53-4d56-afee-7c179d73cff5"}', '2026-09-27 06:47:03.855946+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.270328+09', NULL, NULL, '2026-09-27 06:47:03.855946+09');
INSERT INTO public.outbox VALUES ('52c06de2-a203-4144-9ef6-23371e4878f7', 'tenant-a', 'embed', '{"memoryId": "225c787d-5262-477b-bc1b-34654cb65de6"}', '2026-09-27 06:47:03.885404+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.298409+09', NULL, NULL, '2026-09-27 06:47:03.885404+09');
INSERT INTO public.outbox VALUES ('f68f2db6-36f9-46e5-91f6-f54b1bc5d3a0', 'tenant-a', 'embed', '{"memoryId": "e6795385-77dc-4d84-b0bb-8471e7bd9096"}', '2026-09-27 06:47:03.898255+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.307499+09', NULL, NULL, '2026-09-27 06:47:03.898255+09');
INSERT INTO public.outbox VALUES ('59dd8634-9d68-4d44-9d04-43455b8020d9', 'tenant-a', 'embed', '{"memoryId": "66efbfcd-434a-47ae-a9aa-e887b86be1c0"}', '2026-09-27 06:47:03.910343+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.313175+09', NULL, NULL, '2026-09-27 06:47:03.910343+09');
INSERT INTO public.outbox VALUES ('4c63ffb6-a3b5-463e-bb65-271342133c92', 'tenant-a', 'embed', '{"memoryId": "3eaafd2a-7b9d-4528-a456-aefa9334dced"}', '2026-09-27 06:47:03.918428+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.317256+09', NULL, NULL, '2026-09-27 06:47:03.918428+09');
INSERT INTO public.outbox VALUES ('edc029d2-23cd-4c62-86b1-dadd39ebc567', 'tenant-a', 'embed', '{"memoryId": "8270bfec-5d3f-42e1-ba2b-4ae7ed4e1021"}', '2026-09-27 06:47:03.956026+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.320708+09', NULL, NULL, '2026-09-27 06:47:03.956026+09');
INSERT INTO public.outbox VALUES ('04f32f51-351f-45cc-b7db-fd921afd9e3a', 'tenant-a', 'embed', '{"memoryId": "832a490f-cf53-43db-b433-359c0ce7c5b3"}', '2026-09-27 06:47:03.965565+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.324497+09', NULL, NULL, '2026-09-27 06:47:03.965565+09');
INSERT INTO public.outbox VALUES ('1dcb9009-1175-43e3-97a8-d6710aad61b7', 'tenant-a', 'embed', '{"memoryId": "49988af5-175e-46e3-a4d5-cd85fa4297ec"}', '2026-09-27 06:47:03.97403+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.350319+09', NULL, NULL, '2026-09-27 06:47:03.97403+09');
INSERT INTO public.outbox VALUES ('214ff06c-6644-4fe8-a4e2-76d87956927e', 'tenant-a', 'embed', '{"memoryId": "68a58abd-6862-4aa9-bcc7-dfd9da2ee2e1"}', '2026-09-27 06:47:03.981468+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.356299+09', NULL, NULL, '2026-09-27 06:47:03.981468+09');
INSERT INTO public.outbox VALUES ('618a54ac-98c2-49b9-b76a-482ca601498d', 'tenant-a', 'embed', '{"memoryId": "ac5caf3f-e553-4536-b5cd-e6116d2e9dc4"}', '2026-09-27 06:47:03.988219+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.361177+09', NULL, NULL, '2026-09-27 06:47:03.988219+09');
INSERT INTO public.outbox VALUES ('fe189ab7-084e-422b-82cc-dac7f33cdd67', 'tenant-a', 'embed', '{"memoryId": "a2be48c4-6b6f-4f8e-a5bb-76911530e005"}', '2026-09-27 06:47:04.016104+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.365235+09', NULL, NULL, '2026-09-27 06:47:04.016104+09');
INSERT INTO public.outbox VALUES ('a244e5b8-854b-40b0-a0de-8982124c30bb', 'tenant-a', 'embed', '{"memoryId": "99944142-5307-4131-a395-4bd0807c43c5"}', '2026-09-27 06:47:04.026517+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.369388+09', NULL, NULL, '2026-09-27 06:47:04.026517+09');
INSERT INTO public.outbox VALUES ('f51b08e6-4365-42bd-b321-f1768b60cc15', 'tenant-a', 'embed', '{"memoryId": "0cba8cd1-efff-426e-a281-288ac550bb0f"}', '2026-09-27 06:47:04.03635+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.373569+09', NULL, NULL, '2026-09-27 06:47:04.03635+09');
INSERT INTO public.outbox VALUES ('f4970f25-47f7-4067-8f13-e5fec1a4ccba', 'tenant-a', 'embed', '{"memoryId": "a5ba9494-0185-4a75-be8c-3fe7e27cb290"}', '2026-09-27 06:47:04.069802+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.377539+09', NULL, NULL, '2026-09-27 06:47:04.069802+09');
INSERT INTO public.outbox VALUES ('28fcde93-6be6-4a7d-b735-3ace73202160', 'tenant-a', 'embed', '{"memoryId": "86b07ad9-c438-4798-a7d2-5117484e7108"}', '2026-09-27 06:47:04.08006+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.381274+09', NULL, NULL, '2026-09-27 06:47:04.08006+09');
INSERT INTO public.outbox VALUES ('a20e6feb-ab76-418d-8533-a902eb92097c', 'tenant-a', 'embed', '{"memoryId": "b9be8551-2c8c-458e-a645-539c7b271415"}', '2026-09-27 06:47:04.092221+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.386176+09', NULL, NULL, '2026-09-27 06:47:04.092221+09');
INSERT INTO public.outbox VALUES ('4c169561-f9f5-4e08-aced-a6ad17f0df5a', 'tenant-a', 'embed', '{"memoryId": "1dce5856-2828-44f3-b941-a11b1b9aaa35"}', '2026-09-27 06:47:04.121549+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.411815+09', NULL, NULL, '2026-09-27 06:47:04.121549+09');
INSERT INTO public.outbox VALUES ('94025c22-7077-4a34-bbdb-cbd968c651a5', 'tenant-a', 'embed', '{"memoryId": "6eb13a38-d170-4dde-a76e-abcd9787bd78"}', '2026-09-27 06:47:04.133499+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.419157+09', NULL, NULL, '2026-09-27 06:47:04.133499+09');
INSERT INTO public.outbox VALUES ('eee6bd57-67ec-403a-a529-e14b8dc117a9', 'tenant-a', 'embed', '{"memoryId": "7fcf19ee-0459-4cd2-aafa-5e8f461a1b01"}', '2026-09-27 06:47:04.146123+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.423856+09', NULL, NULL, '2026-09-27 06:47:04.146123+09');
INSERT INTO public.outbox VALUES ('3272897f-7a79-4652-9962-57e03f189b66', 'tenant-a', 'embed', '{"memoryId": "0835061e-e52f-43b1-b7ce-dc9f24f015d7"}', '2026-09-27 06:47:04.18452+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.428048+09', NULL, NULL, '2026-09-27 06:47:04.18452+09');
INSERT INTO public.outbox VALUES ('8c051512-823d-4041-986d-41a2b1293d6b', 'tenant-a', 'embed', '{"memoryId": "aa907ddf-3b5d-400e-b915-c43a6f7af18e"}', '2026-09-27 06:47:04.196267+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.431949+09', NULL, NULL, '2026-09-27 06:47:04.196267+09');
INSERT INTO public.outbox VALUES ('557bdce5-06cc-40e2-91bc-82d24bc6fdc0', 'tenant-a', 'embed', '{"memoryId": "be6f5c44-8a10-4240-aa12-7bda7fab6b5c"}', '2026-09-27 06:47:04.205511+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, '2026-09-27 06:47:04.435913+09', NULL, NULL, '2026-09-27 06:47:04.205511+09');
INSERT INTO public.outbox VALUES ('856a16fe-7259-4385-b8c1-3be755fde9fa', 'tenant-a', 'embed', '{"memoryId": "750c1584-6606-4c4a-b1c3-18011d4271da"}', '2026-09-27 06:47:04.236271+09', '2026-09-27 06:47:04.242+09', 'runtime.tick', 1, NULL, '2026-09-27 06:47:04.439614+09', 'fixture: embedding provider failure', '2026-09-27 06:47:04.236271+09');
INSERT INTO public.outbox VALUES ('14e74c5e-3d9a-43ea-8656-feb2a8c68784', 'tenant-a', 'embed', '{"memoryId": "36a018b7-2baa-4cb8-8ab4-090c046e3e96"}', '2026-09-27 06:47:04.442941+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 06:47:04.442941+09');
INSERT INTO public.outbox VALUES ('4bb0e58c-fd86-4dd0-a095-12591b0587a6', 'tenant-a', 'extract', '{"observationId": "045bdbaf-c42f-4cab-af0b-c928bdfc8dd0"}', '2026-09-27 06:47:04.440457+09', NULL, NULL, 0, '2026-09-27 06:47:04.446854+09', NULL, NULL, '2026-09-27 06:47:04.440457+09');
INSERT INTO public.outbox VALUES ('d6ff8dbb-4357-48f9-888d-c3b36e5278f2', 'tenant-a', 'embed', '{"memoryId": "a2ee63d6-f330-42aa-a2ab-fd96a7562c31"}', '2026-09-27 06:47:04.450907+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 06:47:04.450907+09');
INSERT INTO public.outbox VALUES ('5140d708-678c-4b2e-b301-b9dca7335bc4', 'tenant-a', 'extract', '{"observationId": "810efc55-c962-41ac-8351-99e5945d0869"}', '2026-09-27 06:47:04.447871+09', NULL, NULL, 0, '2026-09-27 06:47:04.475797+09', NULL, NULL, '2026-09-27 06:47:04.447871+09');
INSERT INTO public.outbox VALUES ('ff103e5f-9078-4802-9b77-2e0630912c1f', 'tenant-a', 'embed', '{"memoryId": "b2035fac-a734-43ba-b5cc-f10c27817910"}', '2026-09-27 06:47:04.480016+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 06:47:04.480016+09');
INSERT INTO public.outbox VALUES ('81d1ddf9-29c2-4fb1-915e-214b50269ced', 'tenant-a', 'extract', '{"observationId": "a5291402-6f6c-47eb-9650-6c2acf2ef3a5"}', '2026-09-27 06:47:04.477225+09', NULL, NULL, 0, '2026-09-27 06:47:04.491462+09', NULL, NULL, '2026-09-27 06:47:04.477225+09');
INSERT INTO public.outbox VALUES ('397ad05a-970e-4a68-967e-87881f7078d2', 'tenant-b', 'extract', '{"observationId": "9e54e7f6-35ce-4678-b590-32302e50456b"}', '2026-09-27 06:47:04.579405+09', NULL, NULL, 0, '2026-09-27 06:47:04.58812+09', NULL, NULL, '2026-09-27 06:47:04.579405+09');
INSERT INTO public.outbox VALUES ('7dfeadba-a80a-44e6-9d24-961a7fcd2ddf', 'tenant-b', 'extract', '{"observationId": "76c3d7a7-4581-4814-9bb4-878b5cf248b3"}', '2026-09-27 06:47:04.589157+09', NULL, NULL, 0, '2026-09-27 06:47:04.617583+09', NULL, NULL, '2026-09-27 06:47:04.589157+09');
INSERT INTO public.outbox VALUES ('5fb94372-b78f-48ca-8892-a278ac289c81', 'tenant-b', 'extract', '{"observationId": "177de721-aab2-42fa-b864-37dafe3272c3"}', '2026-09-27 06:47:04.618988+09', NULL, NULL, 0, '2026-09-27 06:47:04.628824+09', NULL, NULL, '2026-09-27 06:47:04.618988+09');
INSERT INTO public.outbox VALUES ('d368d9e6-fb33-4677-8a3b-4efcf0e7af8a', 'tenant-b', 'extract', '{"observationId": "6f659e44-a05b-4d48-9cef-fb48313ec4b9"}', '2026-09-27 06:47:04.629923+09', NULL, NULL, 0, '2026-09-27 06:47:04.63664+09', NULL, NULL, '2026-09-27 06:47:04.629923+09');
INSERT INTO public.outbox VALUES ('13ddba77-14da-48f6-93e4-c6b630c36bcd', 'tenant-b', 'extract', '{"observationId": "ddafa6bf-1bdc-4798-a4d3-3eb97e5c654b"}', '2026-09-27 06:47:04.637372+09', NULL, NULL, 0, '2026-09-27 06:47:04.643344+09', NULL, NULL, '2026-09-27 06:47:04.637372+09');
INSERT INTO public.outbox VALUES ('3b466297-5ec2-4c8d-b60e-b71e6a2fb147', 'tenant-b', 'extract', '{"observationId": "e293009b-c565-41a2-8250-73b7900e14c0"}', '2026-09-27 06:47:04.644093+09', NULL, NULL, 0, '2026-09-27 06:47:04.6517+09', NULL, NULL, '2026-09-27 06:47:04.644093+09');
INSERT INTO public.outbox VALUES ('71c94ae4-b698-4c49-9ae0-f33fbf01f383', 'tenant-b', 'extract', '{"observationId": "8c7c0941-2135-41b6-911a-7bef9e538330"}', '2026-09-27 06:47:04.652529+09', NULL, NULL, 0, '2026-09-27 06:47:04.658177+09', NULL, NULL, '2026-09-27 06:47:04.652529+09');
INSERT INTO public.outbox VALUES ('ef933b04-a340-41d8-a08d-a521650b1242', 'tenant-b', 'extract', '{"observationId": "4b4fce0d-e028-4459-ac60-fb1a7a20a2ef"}', '2026-09-27 06:47:04.65908+09', NULL, NULL, 0, '2026-09-27 06:47:04.664593+09', NULL, NULL, '2026-09-27 06:47:04.65908+09');
INSERT INTO public.outbox VALUES ('5461f281-34af-471c-a9c2-9dd5de8931b0', 'tenant-b', 'embed', '{"memoryId": "17bbbe8b-48ca-477d-9f23-ee0824a28178"}', '2026-09-27 06:47:04.583934+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.800423+09', NULL, NULL, '2026-09-27 06:47:04.583934+09');
INSERT INTO public.outbox VALUES ('c5428ce6-309d-470e-90f0-08896a556aae', 'tenant-b', 'extract', '{"observationId": "29a5998c-465a-4df5-a3b3-57042fb3956f"}', '2026-09-27 06:47:04.665509+09', NULL, NULL, 0, '2026-09-27 06:47:04.700319+09', NULL, NULL, '2026-09-27 06:47:04.665509+09');
INSERT INTO public.outbox VALUES ('c235a86d-377b-4ac9-a29b-ad0f4f50c7a3', 'tenant-b', 'extract', '{"observationId": "4076cbc1-1e4f-405c-ae37-518fcbfc94ff"}', '2026-09-27 06:47:04.7014+09', NULL, NULL, 0, '2026-09-27 06:47:04.710483+09', NULL, NULL, '2026-09-27 06:47:04.7014+09');
INSERT INTO public.outbox VALUES ('6b18709c-a117-4e48-ad71-47438032d304', 'tenant-b', 'extract', '{"observationId": "8a07f665-e2b2-4b97-9311-5aa2a3601482"}', '2026-09-27 06:47:04.7115+09', NULL, NULL, 0, '2026-09-27 06:47:04.718335+09', NULL, NULL, '2026-09-27 06:47:04.7115+09');
INSERT INTO public.outbox VALUES ('06d3ed31-d1e2-41b8-9de9-725cc1a23ac2', 'tenant-b', 'extract', '{"observationId": "e914f4e2-a1e6-4c22-814e-af8b1d0c5ed6"}', '2026-09-27 06:47:04.719229+09', NULL, NULL, 0, '2026-09-27 06:47:04.724926+09', NULL, NULL, '2026-09-27 06:47:04.719229+09');
INSERT INTO public.outbox VALUES ('a2e9fc29-223c-4822-8d9c-8feacf09caec', 'tenant-b', 'extract', '{"observationId": "975dd48d-d7ea-44d1-888e-6d25332c0b71"}', '2026-09-27 06:47:04.725779+09', NULL, NULL, 0, '2026-09-27 06:47:04.731459+09', NULL, NULL, '2026-09-27 06:47:04.725779+09');
INSERT INTO public.outbox VALUES ('5694fb3e-0261-4bb2-a4d0-9b5073f4c211', 'tenant-b', 'extract', '{"observationId": "2d27c2d7-31df-44b8-9559-37a9839a1780"}', '2026-09-27 06:47:04.732103+09', NULL, NULL, 0, '2026-09-27 06:47:04.737146+09', NULL, NULL, '2026-09-27 06:47:04.732103+09');
INSERT INTO public.outbox VALUES ('078acf2d-3ed4-4af9-ba83-403296920886', 'tenant-b', 'extract', '{"observationId": "6e7fa68b-f899-4b06-80d4-a81cfb51cd85"}', '2026-09-27 06:47:04.737707+09', NULL, NULL, 0, '2026-09-27 06:47:04.764968+09', NULL, NULL, '2026-09-27 06:47:04.737707+09');
INSERT INTO public.outbox VALUES ('ff14024e-c225-4d8e-bf48-04508dafc151', 'tenant-b', 'extract', '{"observationId": "334f7a38-7f81-434b-80cc-a5d0dc92e506"}', '2026-09-27 06:47:04.766497+09', NULL, NULL, 0, '2026-09-27 06:47:04.777216+09', NULL, NULL, '2026-09-27 06:47:04.766497+09');
INSERT INTO public.outbox VALUES ('a2e10cdc-0763-4223-8961-554c4e060a23', 'tenant-b', 'extract', '{"observationId": "9e5082da-ac08-4c9b-a292-704def191716"}', '2026-09-27 06:47:04.777941+09', NULL, NULL, 0, '2026-09-27 06:47:04.782512+09', NULL, NULL, '2026-09-27 06:47:04.777941+09');
INSERT INTO public.outbox VALUES ('7b9ad9c4-5575-440e-a420-86513c9d63a1', 'tenant-b', 'extract', '{"observationId": "3628f18e-b9ef-4ba8-ad24-8b547af5649a"}', '2026-09-27 06:47:04.783383+09', NULL, NULL, 0, '2026-09-27 06:47:04.787739+09', NULL, NULL, '2026-09-27 06:47:04.783383+09');
INSERT INTO public.outbox VALUES ('298295d9-df3d-42c1-9858-919ae3b1f11c', 'tenant-b', 'extract', '{"observationId": "15956ed8-d1dd-4ebd-94fd-cddabc9da6bd"}', '2026-09-27 06:47:04.788383+09', NULL, NULL, 0, '2026-09-27 06:47:04.793793+09', NULL, NULL, '2026-09-27 06:47:04.788383+09');
INSERT INTO public.outbox VALUES ('43288b68-bdff-4e39-b62a-b1d897fbb8f2', 'tenant-b', 'embed', '{"memoryId": "05339903-a1c8-4d2e-9ab2-b5076861c246"}', '2026-09-27 06:47:04.613468+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.805411+09', NULL, NULL, '2026-09-27 06:47:04.613468+09');
INSERT INTO public.outbox VALUES ('a5822352-6014-4243-90b9-5fa7596e395f', 'tenant-b', 'embed', '{"memoryId": "655eec4c-c86e-4e79-a9c6-272dd91956ae"}', '2026-09-27 06:47:04.622442+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.809367+09', NULL, NULL, '2026-09-27 06:47:04.622442+09');
INSERT INTO public.outbox VALUES ('9bab756d-0c56-4cd6-8133-a0ce7a77fee0', 'tenant-b', 'embed', '{"memoryId": "70d9d481-0c24-419d-8b8c-9c799ae20937"}', '2026-09-27 06:47:04.6331+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.83142+09', NULL, NULL, '2026-09-27 06:47:04.6331+09');
INSERT INTO public.outbox VALUES ('6e07a24d-2050-4068-b160-36a540dc0c71', 'tenant-b', 'embed', '{"memoryId": "4ca5d6d2-6b8c-4a0b-8970-f8589e4af8f3"}', '2026-09-27 06:47:04.639796+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.835735+09', NULL, NULL, '2026-09-27 06:47:04.639796+09');
INSERT INTO public.outbox VALUES ('155efff6-cfeb-4bd7-9df1-7a14b07aa7a1', 'tenant-b', 'embed', '{"memoryId": "b9d95781-0306-4f16-970b-a6407dbf43d5"}', '2026-09-27 06:47:04.647873+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.839901+09', NULL, NULL, '2026-09-27 06:47:04.647873+09');
INSERT INTO public.outbox VALUES ('6b8db238-1835-4738-8e91-43ebe7aa0d9c', 'tenant-b', 'embed', '{"memoryId": "290d95d6-4c0b-4562-988d-b823f1cd16a6"}', '2026-09-27 06:47:04.655103+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.843952+09', NULL, NULL, '2026-09-27 06:47:04.655103+09');
INSERT INTO public.outbox VALUES ('2f75d1f7-0da5-4bcc-88c2-8c4886e85ed0', 'tenant-b', 'embed', '{"memoryId": "77f282a1-d45c-4f7e-b003-a80deaa55028"}', '2026-09-27 06:47:04.661393+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.848261+09', NULL, NULL, '2026-09-27 06:47:04.661393+09');
INSERT INTO public.outbox VALUES ('ec6e2fac-c76c-40c8-a735-5377782b66a0', 'tenant-b', 'embed', '{"memoryId": "d9794124-d2d6-445d-9d43-a489e11c12d3"}', '2026-09-27 06:47:04.667742+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.852434+09', NULL, NULL, '2026-09-27 06:47:04.667742+09');
INSERT INTO public.outbox VALUES ('b9dd4ed2-bbc8-449e-b4e1-43431dc4bd91', 'tenant-b', 'embed', '{"memoryId": "f0425304-d570-4912-a232-e76f59b1641a"}', '2026-09-27 06:47:04.705162+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.855964+09', NULL, NULL, '2026-09-27 06:47:04.705162+09');
INSERT INTO public.outbox VALUES ('4bd8b6d1-114e-4349-8f72-67b7a1807272', 'tenant-b', 'embed', '{"memoryId": "37d9404a-ea7c-4588-99c9-8f76243a8c4d"}', '2026-09-27 06:47:04.714798+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.859788+09', NULL, NULL, '2026-09-27 06:47:04.714798+09');
INSERT INTO public.outbox VALUES ('6f8ab670-0e1c-4fb6-9746-ec0928ab7012', 'tenant-b', 'embed', '{"memoryId": "085702e3-9122-4924-b3b6-a2aba20b3c50"}', '2026-09-27 06:47:04.721704+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.864403+09', NULL, NULL, '2026-09-27 06:47:04.721704+09');
INSERT INTO public.outbox VALUES ('0b008737-a9dd-4ca3-a98e-020bd6d3d247', 'tenant-b', 'embed', '{"memoryId": "ac7309cc-d0ce-4b13-83f4-94685cc6c8b7"}', '2026-09-27 06:47:04.727851+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.868242+09', NULL, NULL, '2026-09-27 06:47:04.727851+09');
INSERT INTO public.outbox VALUES ('5b449700-1d5d-4f59-9ba5-4c7b4672d743', 'tenant-b', 'embed', '{"memoryId": "457bce5f-e77d-4b92-8d18-e37d9f632477"}', '2026-09-27 06:47:04.734289+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.871447+09', NULL, NULL, '2026-09-27 06:47:04.734289+09');
INSERT INTO public.outbox VALUES ('00f79aed-9827-4844-b030-83d51ce6490e', 'tenant-b', 'embed', '{"memoryId": "6b663b08-a3b9-47c1-877f-437136fab799"}', '2026-09-27 06:47:04.740213+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.876347+09', NULL, NULL, '2026-09-27 06:47:04.740213+09');
INSERT INTO public.outbox VALUES ('2dc72e11-da6b-44b9-baa4-d1051e561128', 'tenant-b', 'embed', '{"memoryId": "16ac3149-2d51-4a65-8d1e-9fb359eab713"}', '2026-09-27 06:47:04.771145+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.880064+09', NULL, NULL, '2026-09-27 06:47:04.771145+09');
INSERT INTO public.outbox VALUES ('d3bbdf39-96f0-4104-aa66-447da5e75762', 'tenant-b', 'embed', '{"memoryId": "5e63de98-905a-4fb3-8e65-45bd5c514b3c"}', '2026-09-27 06:47:04.779666+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.916463+09', NULL, NULL, '2026-09-27 06:47:04.779666+09');
INSERT INTO public.outbox VALUES ('6dcad595-a74c-4eca-abd4-82fd16301365', 'tenant-b', 'embed', '{"memoryId": "84a40b66-54af-4eea-9777-4b7c47a2ec64"}', '2026-09-27 06:47:04.785331+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, '2026-09-27 06:47:04.922016+09', NULL, NULL, '2026-09-27 06:47:04.785331+09');
INSERT INTO public.outbox VALUES ('8f78064f-a864-4c76-9580-a5f1ffc61e75', 'tenant-b', 'embed', '{"memoryId": "492cdfac-fada-43de-9cde-ca890ec1f88d"}', '2026-09-27 06:47:04.790782+09', '2026-09-27 06:47:04.794+09', 'runtime.tick', 1, NULL, '2026-09-27 06:47:04.927299+09', 'fixture: embedding provider failure', '2026-09-27 06:47:04.790782+09');
INSERT INTO public.outbox VALUES ('50fa6649-4137-4cc8-a737-482eb3b72195', 'tenant-b', 'embed', '{"memoryId": "7764b9f6-9eb7-4370-bfca-1197c5964425"}', '2026-09-27 06:47:04.932465+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 06:47:04.932465+09');
INSERT INTO public.outbox VALUES ('7ba21f5a-5dce-4157-a1c7-4fdf2da14104', 'tenant-b', 'extract', '{"observationId": "d765d976-65b6-47cb-91a8-d13349544725"}', '2026-09-27 06:47:04.929866+09', NULL, NULL, 0, '2026-09-27 06:47:04.935269+09', NULL, NULL, '2026-09-27 06:47:04.929866+09');
INSERT INTO public.outbox VALUES ('0cdc3cbf-3417-4447-a73b-80a2c4c1e378', 'tenant-b', 'embed', '{"memoryId": "2c995ff0-846b-470b-9d57-7d41ba1e4e25"}', '2026-09-27 06:47:04.938518+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 06:47:04.938518+09');
INSERT INTO public.outbox VALUES ('a2ec5e9c-c710-4b43-ad47-3bcc9600e911', 'tenant-b', 'extract', '{"observationId": "ca3c6a0e-fe92-4d6a-aed7-9d2e338c043d"}', '2026-09-27 06:47:04.936098+09', NULL, NULL, 0, '2026-09-27 06:47:04.943877+09', NULL, NULL, '2026-09-27 06:47:04.936098+09');
INSERT INTO public.outbox VALUES ('307d71e8-02a2-406e-9323-1484699234f8', 'tenant-b', 'embed', '{"memoryId": "65dcf125-5efb-4566-9735-57d445b78547"}', '2026-09-27 06:47:04.965729+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 06:47:04.965729+09');
INSERT INTO public.outbox VALUES ('9709149c-6909-47da-a334-a4a6fd08deee', 'tenant-b', 'extract', '{"observationId": "2a05c925-c5a3-4090-a896-d53d2bdebcce"}', '2026-09-27 06:47:04.944856+09', NULL, NULL, 0, '2026-09-27 06:47:04.970943+09', NULL, NULL, '2026-09-27 06:47:04.944856+09');
INSERT INTO public.outbox VALUES ('9db67395-7fe2-4d9b-82ac-c4582061a233', 'tenant-c', 'extract', '{"observationId": "40f8d001-aa71-4262-ade3-b9352dc73ca3"}', '2026-09-27 06:47:05.031369+09', NULL, NULL, 0, '2026-09-27 06:47:05.03824+09', NULL, NULL, '2026-09-27 06:47:05.031369+09');
INSERT INTO public.outbox VALUES ('6b8fe04f-c621-4dc6-abd9-0cbe8e2cc2b0', 'tenant-c', 'extract', '{"observationId": "d7d347fc-8855-49d0-a4ef-f42ca820c487"}', '2026-09-27 06:47:05.039651+09', NULL, NULL, 0, '2026-09-27 06:47:05.046916+09', NULL, NULL, '2026-09-27 06:47:05.039651+09');
INSERT INTO public.outbox VALUES ('1187f8ee-0c55-4a9a-b974-0ac8e01a2c72', 'tenant-c', 'extract', '{"observationId": "efeb5cbd-7b75-4e52-94a7-e01bc2980a6e"}', '2026-09-27 06:47:05.047878+09', NULL, NULL, 0, '2026-09-27 06:47:05.056693+09', NULL, NULL, '2026-09-27 06:47:05.047878+09');
INSERT INTO public.outbox VALUES ('a5cee726-f9ed-44a9-8926-927f1a851d88', 'tenant-c', 'extract', '{"observationId": "96dff28e-bb33-4a79-adab-f2aa8fad7c11"}', '2026-09-27 06:47:05.058505+09', NULL, NULL, 0, '2026-09-27 06:47:05.09288+09', NULL, NULL, '2026-09-27 06:47:05.058505+09');
INSERT INTO public.outbox VALUES ('50fc8f89-0b56-4977-952c-b7f6dc0bcfc4', 'tenant-c', 'extract', '{"observationId": "d39d6580-3b30-4c25-9b7a-82ecc090f4bd"}', '2026-09-27 06:47:05.095168+09', NULL, NULL, 0, '2026-09-27 06:47:05.101585+09', NULL, NULL, '2026-09-27 06:47:05.095168+09');
INSERT INTO public.outbox VALUES ('1b9c6a69-753f-4197-9047-4d1233f5baf9', 'tenant-c', 'extract', '{"observationId": "f7ffa030-0e96-43dd-8b54-1289a7d5f466"}', '2026-09-27 06:47:05.102508+09', NULL, NULL, 0, '2026-09-27 06:47:05.107386+09', NULL, NULL, '2026-09-27 06:47:05.102508+09');
INSERT INTO public.outbox VALUES ('c4a32de5-30e4-4d73-8676-e47166a31434', 'tenant-c', 'extract', '{"observationId": "bfee10e5-f991-45c6-a6e2-5d73b8587728"}', '2026-09-27 06:47:05.108199+09', NULL, NULL, 0, '2026-09-27 06:47:05.13831+09', NULL, NULL, '2026-09-27 06:47:05.108199+09');
INSERT INTO public.outbox VALUES ('622d6cdb-1d6a-4d6d-9565-71f394bc756c', 'tenant-c', 'extract', '{"observationId": "65414fe2-78c3-46ed-b0e4-f6ee55e408c5"}', '2026-09-27 06:47:05.139669+09', NULL, NULL, 0, '2026-09-27 06:47:05.14578+09', NULL, NULL, '2026-09-27 06:47:05.139669+09');
INSERT INTO public.outbox VALUES ('d7252312-047e-46e5-80bf-71c46c1c362d', 'tenant-c', 'extract', '{"observationId": "f1e670f7-fd06-4da5-8d85-b1991c437e3b"}', '2026-09-27 06:47:05.146622+09', NULL, NULL, 0, '2026-09-27 06:47:05.151883+09', NULL, NULL, '2026-09-27 06:47:05.146622+09');
INSERT INTO public.outbox VALUES ('7237e317-9de4-44d5-8a0e-5429f6b32327', 'tenant-c', 'extract', '{"observationId": "d18558a0-d1e2-4cff-ab59-9a3dbfc90e65"}', '2026-09-27 06:47:05.152614+09', NULL, NULL, 0, '2026-09-27 06:47:05.158887+09', NULL, NULL, '2026-09-27 06:47:05.152614+09');
INSERT INTO public.outbox VALUES ('8b390115-3dfe-41c7-bd01-ebc308ba5f6f', 'tenant-c', 'extract', '{"observationId": "b33e68b1-f572-4b3a-a99d-0296c22594ce"}', '2026-09-27 06:47:05.159923+09', NULL, NULL, 0, '2026-09-27 06:47:05.166216+09', NULL, NULL, '2026-09-27 06:47:05.159923+09');
INSERT INTO public.outbox VALUES ('5a97ee69-9205-4022-9362-024a9171ccea', 'tenant-c', 'extract', '{"observationId": "c113d9b0-f9a4-4959-a843-8596f8121a3a"}', '2026-09-27 06:47:05.200092+09', NULL, NULL, 0, '2026-09-27 06:47:05.20837+09', NULL, NULL, '2026-09-27 06:47:05.200092+09');
INSERT INTO public.outbox VALUES ('1cff25a3-6ad3-4173-8bbf-c6939232bc33', 'tenant-c', 'extract', '{"observationId": "d8b322fb-02ba-4c39-928f-2a7a4f3d0ad7"}', '2026-09-27 06:47:05.209434+09', NULL, NULL, 0, '2026-09-27 06:47:05.217094+09', NULL, NULL, '2026-09-27 06:47:05.209434+09');
INSERT INTO public.outbox VALUES ('3de8da87-5510-437e-bee0-137e4736a3c4', 'tenant-c', 'embed', '{"memoryId": "f74f1a5e-9254-4da2-b201-793f4a707663"}', '2026-09-27 06:47:05.034794+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, '2026-09-27 06:47:05.224293+09', NULL, NULL, '2026-09-27 06:47:05.034794+09');
INSERT INTO public.outbox VALUES ('9fdeef88-4a78-4f41-9d56-ecb8a51ca074', 'tenant-c', 'embed', '{"memoryId": "1b9b19b9-a36c-42f6-ad73-dd1be3956fd1"}', '2026-09-27 06:47:05.043136+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, '2026-09-27 06:47:05.228701+09', NULL, NULL, '2026-09-27 06:47:05.043136+09');
INSERT INTO public.outbox VALUES ('34ef8b88-17af-44f3-85d5-36483d9f9dbf', 'tenant-c', 'embed', '{"memoryId": "c423022b-93bf-40d5-a507-6430f41caba8"}', '2026-09-27 06:47:05.051067+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, '2026-09-27 06:47:05.255684+09', NULL, NULL, '2026-09-27 06:47:05.051067+09');
INSERT INTO public.outbox VALUES ('589c8e4e-8cee-4af5-8071-e585a3320eec', 'tenant-c', 'embed', '{"memoryId": "bf117f84-8fef-4dba-ad41-516b81ce1649"}', '2026-09-27 06:47:05.087919+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, '2026-09-27 06:47:05.261245+09', NULL, NULL, '2026-09-27 06:47:05.087919+09');
INSERT INTO public.outbox VALUES ('0a0a08a6-a08e-4c3e-b10c-7530ffaf1f83', 'tenant-c', 'embed', '{"memoryId": "7c807ea0-c1dc-4b65-8123-411e0325f5ce"}', '2026-09-27 06:47:05.098516+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, '2026-09-27 06:47:05.266648+09', NULL, NULL, '2026-09-27 06:47:05.098516+09');
INSERT INTO public.outbox VALUES ('ac8d5ff4-23d3-4afc-8b63-54aeed972027', 'tenant-c', 'embed', '{"memoryId": "eaf39e64-e7e9-4642-aa6b-e415f7bcfb1a"}', '2026-09-27 06:47:05.104492+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, '2026-09-27 06:47:05.27147+09', NULL, NULL, '2026-09-27 06:47:05.104492+09');
INSERT INTO public.outbox VALUES ('ff6a1948-6ceb-410d-a7b6-f177fcab123e', 'tenant-c', 'embed', '{"memoryId": "b05cf74d-9056-48d6-a7c3-fe9f92fe311a"}', '2026-09-27 06:47:05.131936+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, '2026-09-27 06:47:05.27674+09', NULL, NULL, '2026-09-27 06:47:05.131936+09');
INSERT INTO public.outbox VALUES ('5780199c-d08f-4220-b2f7-636c0e46a1b0', 'tenant-c', 'embed', '{"memoryId": "10563ca6-bc9c-48ba-9f6c-405444cfc9cb"}', '2026-09-27 06:47:05.14269+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, '2026-09-27 06:47:05.280864+09', NULL, NULL, '2026-09-27 06:47:05.14269+09');
INSERT INTO public.outbox VALUES ('a40ef586-ebb0-4b17-acd6-c8609ce9c2bc', 'tenant-c', 'embed', '{"memoryId": "78a6562a-224a-4cdc-a0ec-a01f70aa92f8"}', '2026-09-27 06:47:05.148639+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, '2026-09-27 06:47:05.284384+09', NULL, NULL, '2026-09-27 06:47:05.148639+09');
INSERT INTO public.outbox VALUES ('2c555add-5665-4b82-88f0-4ce991ce83d3', 'tenant-c', 'embed', '{"memoryId": "1b0ed14f-9100-45fb-9a56-46163fd46ff5"}', '2026-09-27 06:47:05.155438+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, '2026-09-27 06:47:05.288622+09', NULL, NULL, '2026-09-27 06:47:05.155438+09');
INSERT INTO public.outbox VALUES ('a0f6f9a5-e422-4d43-b008-8aa521a7ab41', 'tenant-c', 'embed', '{"memoryId": "cb6047fc-1d5d-4f42-b4a1-0869ab8c01d1"}', '2026-09-27 06:47:05.162427+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, '2026-09-27 06:47:05.294125+09', NULL, NULL, '2026-09-27 06:47:05.162427+09');
INSERT INTO public.outbox VALUES ('62b3465e-2959-4544-8558-5377d52ae55a', 'tenant-c', 'embed', '{"memoryId": "eabc19c0-408b-4906-9c0b-c4cc03590564"}', '2026-09-27 06:47:05.204121+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, '2026-09-27 06:47:05.299648+09', NULL, NULL, '2026-09-27 06:47:05.204121+09');
INSERT INTO public.outbox VALUES ('aa2126d1-53c2-4ba3-ac2d-3683ded46ae8', 'tenant-c', 'embed', '{"memoryId": "27c504ea-4489-41ee-b6a0-d402b449ee6f"}', '2026-09-27 06:47:05.212671+09', '2026-09-27 06:47:05.218+09', 'runtime.tick', 1, NULL, '2026-09-27 06:47:05.327481+09', 'fixture: embedding provider failure', '2026-09-27 06:47:05.212671+09');
INSERT INTO public.outbox VALUES ('8c06a6e5-e501-44a8-9299-94c47b89ab79', 'tenant-c', 'embed', '{"memoryId": "6e9d888c-c626-474d-900c-29ddbef80fef"}', '2026-09-27 06:47:05.33315+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 06:47:05.33315+09');
INSERT INTO public.outbox VALUES ('aa0eab04-54e1-4115-bdae-7af2f8d63bbc', 'tenant-c', 'extract', '{"observationId": "f5c401fb-6edd-48c4-ba8b-46af5621c7bb"}', '2026-09-27 06:47:05.328803+09', NULL, NULL, 0, '2026-09-27 06:47:05.338305+09', NULL, NULL, '2026-09-27 06:47:05.328803+09');
INSERT INTO public.outbox VALUES ('4d1f306e-45a9-4137-8c58-8e450f0c846d', 'tenant-c', 'embed', '{"memoryId": "1ec5034e-fd0e-4d63-bd8f-26843d448006"}', '2026-09-27 06:47:05.341478+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 06:47:05.341478+09');
INSERT INTO public.outbox VALUES ('e66a0809-fdb4-4550-984a-9a89400133c7', 'tenant-c', 'extract', '{"observationId": "8eeada59-c215-444f-9097-97eb675ddaa0"}', '2026-09-27 06:47:05.339436+09', NULL, NULL, 0, '2026-09-27 06:47:05.346119+09', NULL, NULL, '2026-09-27 06:47:05.339436+09');
INSERT INTO public.outbox VALUES ('2cff1b4c-e480-4f16-8eab-4404bba184ee', 'tenant-c', 'embed', '{"memoryId": "faa17efc-d683-42fe-bc28-4720ea837a52"}', '2026-09-27 06:47:05.356845+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 06:47:05.356845+09');
INSERT INTO public.outbox VALUES ('9ed2b5bd-76ec-426c-b238-1316a104a309', 'tenant-c', 'extract', '{"observationId": "e40adc96-c6a2-439a-8743-d9483aab7020"}', '2026-09-27 06:47:05.350818+09', NULL, NULL, 0, '2026-09-27 06:47:05.362747+09', NULL, NULL, '2026-09-27 06:47:05.350818+09');
INSERT INTO public.outbox VALUES ('b7c6043c-9d01-4870-97ab-096eddb73f7e', 'tenant-a2', 'extract', '{"observationId": "73796916-1502-4964-8d5e-2695e7bc3d3b"}', '2026-09-27 06:47:05.42457+09', NULL, NULL, 0, '2026-09-27 06:47:05.428475+09', NULL, NULL, '2026-09-27 06:47:05.42457+09');
INSERT INTO public.outbox VALUES ('23183857-5e09-4bbd-9aed-d76dc69d086d', 'tenant-a2', 'extract', '{"observationId": "233db03d-a4af-4937-b018-5e849d6f5473"}', '2026-09-27 06:47:05.429028+09', NULL, NULL, 0, '2026-09-27 06:47:05.45846+09', NULL, NULL, '2026-09-27 06:47:05.429028+09');
INSERT INTO public.outbox VALUES ('ea312dc1-fb6f-4661-abd2-34c6fe3ca30d', 'tenant-a2', 'extract', '{"observationId": "b0e496ff-7ca1-4b31-929d-632cbb5b810e"}', '2026-09-27 06:47:05.459748+09', NULL, NULL, 0, '2026-09-27 06:47:05.468842+09', NULL, NULL, '2026-09-27 06:47:05.459748+09');
INSERT INTO public.outbox VALUES ('9dd355fd-c916-4a6b-9ce5-b1200be79495', 'tenant-a2', 'extract', '{"observationId": "a6a8e7f1-0b79-414e-a622-bbc2eff6de18"}', '2026-09-27 06:47:05.469517+09', NULL, NULL, 0, '2026-09-27 06:47:05.474912+09', NULL, NULL, '2026-09-27 06:47:05.469517+09');
INSERT INTO public.outbox VALUES ('bf7ffa83-444c-4da3-86fd-7d886d57aea4', 'tenant-a2', 'embed', '{"memoryId": "c2cbb566-6b1c-40b0-8091-b7eb4723754a"}', '2026-09-27 06:47:05.426365+09', '2026-09-27 06:47:05.532+09', 'runtime.tick', 1, '2026-09-27 06:47:05.53621+09', NULL, NULL, '2026-09-27 06:47:05.426365+09');
INSERT INTO public.outbox VALUES ('70df1395-3a8d-4001-9866-fe93f6506b07', 'tenant-a2', 'extract', '{"observationId": "aad7e883-200b-42cc-a26f-f04e84072157"}', '2026-09-27 06:47:05.475784+09', NULL, NULL, 0, '2026-09-27 06:47:05.481359+09', NULL, NULL, '2026-09-27 06:47:05.475784+09');
INSERT INTO public.outbox VALUES ('6af5b7ed-42e7-4f72-8199-e766969f6377', 'tenant-a2', 'extract', '{"observationId": "138d04b2-1698-46bd-801e-73d94ba8ef47"}', '2026-09-27 06:47:05.482301+09', NULL, NULL, 0, '2026-09-27 06:47:05.488934+09', NULL, NULL, '2026-09-27 06:47:05.482301+09');
INSERT INTO public.outbox VALUES ('78b48301-227d-41db-aeab-ed970c93a616', 'tenant-a2', 'extract', '{"observationId": "0ce2d2e7-0409-4de0-836a-c87fae1cccf1"}', '2026-09-27 06:47:05.489546+09', NULL, NULL, 0, '2026-09-27 06:47:05.493869+09', NULL, NULL, '2026-09-27 06:47:05.489546+09');
INSERT INTO public.outbox VALUES ('cc1cb759-5b21-4faf-a8f1-8e0282bc5e05', 'tenant-a2', 'extract', '{"observationId": "67606c7e-a4aa-4ea3-9d3b-609d7b2bea60"}', '2026-09-27 06:47:05.494569+09', NULL, NULL, 0, '2026-09-27 06:47:05.498574+09', NULL, NULL, '2026-09-27 06:47:05.494569+09');
INSERT INTO public.outbox VALUES ('2aa9684d-8008-42fd-9a03-c71276f31511', 'tenant-a2', 'extract', '{"observationId": "d4daa1df-c124-447c-8d28-b2e87dde68af"}', '2026-09-27 06:47:05.499345+09', NULL, NULL, 0, '2026-09-27 06:47:05.504478+09', NULL, NULL, '2026-09-27 06:47:05.499345+09');
INSERT INTO public.outbox VALUES ('7c05b6ca-56b5-4974-9d83-5453c69840e5', 'tenant-a2', 'extract', '{"observationId": "39cdbcfd-181b-4dcd-9dee-6177061a8998"}', '2026-09-27 06:47:05.50517+09', NULL, NULL, 0, '2026-09-27 06:47:05.525119+09', NULL, NULL, '2026-09-27 06:47:05.50517+09');
INSERT INTO public.outbox VALUES ('71a18c17-6bf2-4303-9de6-27a9bb6e8944', 'tenant-a2', 'extract', '{"observationId": "0c4dd196-352a-4ac8-9780-92a9f7e415a0"}', '2026-09-27 06:47:05.526171+09', NULL, NULL, 0, '2026-09-27 06:47:05.53168+09', NULL, NULL, '2026-09-27 06:47:05.526171+09');
INSERT INTO public.outbox VALUES ('eec9fd65-a8ca-47b8-96e2-dfb5f9194c0c', 'tenant-a2', 'embed', '{"memoryId": "24540d97-3daa-4014-9128-0819f6fba9db"}', '2026-09-27 06:47:05.452147+09', '2026-09-27 06:47:05.532+09', 'runtime.tick', 1, '2026-09-27 06:47:05.539734+09', NULL, NULL, '2026-09-27 06:47:05.452147+09');
INSERT INTO public.outbox VALUES ('a10e8f2c-3c03-4ae5-b80b-50ed9acf1003', 'tenant-a2', 'embed', '{"memoryId": "7a31e516-db8c-4770-bef1-636a6939e8ce"}', '2026-09-27 06:47:05.464731+09', '2026-09-27 06:47:05.532+09', 'runtime.tick', 1, '2026-09-27 06:47:05.542933+09', NULL, NULL, '2026-09-27 06:47:05.464731+09');
INSERT INTO public.outbox VALUES ('b3065674-3283-4ae8-80c8-c54849b9f543', 'tenant-a2', 'embed', '{"memoryId": "58208bdb-901d-4dbb-bb18-191dca147cad"}', '2026-09-27 06:47:05.471381+09', '2026-09-27 06:47:05.532+09', 'runtime.tick', 1, '2026-09-27 06:47:05.549456+09', NULL, NULL, '2026-09-27 06:47:05.471381+09');
INSERT INTO public.outbox VALUES ('be19125a-e0e4-4a0e-a15a-28ccbb281ffe', 'tenant-a2', 'embed', '{"memoryId": "bc45305e-f66b-4259-87fc-7e95d0aaf321"}', '2026-09-27 06:47:05.477985+09', '2026-09-27 06:47:05.532+09', 'runtime.tick', 1, '2026-09-27 06:47:05.55577+09', NULL, NULL, '2026-09-27 06:47:05.477985+09');
INSERT INTO public.outbox VALUES ('86a6398b-0950-4ea7-aa76-435f89e6d1e1', 'tenant-a2', 'embed', '{"memoryId": "78d7dd8f-9d66-44e9-b0f6-e12e21fa9701"}', '2026-09-27 06:47:05.486026+09', '2026-09-27 06:47:05.532+09', 'runtime.tick', 1, '2026-09-27 06:47:05.560031+09', NULL, NULL, '2026-09-27 06:47:05.486026+09');
INSERT INTO public.outbox VALUES ('61588446-0d3d-4ec0-8a0d-a96d4897b18d', 'tenant-a2', 'embed', '{"memoryId": "de88d53a-db55-4df4-a95e-13076083d22f"}', '2026-09-27 06:47:05.491531+09', '2026-09-27 06:47:05.532+09', 'runtime.tick', 1, '2026-09-27 06:47:05.563712+09', NULL, NULL, '2026-09-27 06:47:05.491531+09');
INSERT INTO public.outbox VALUES ('a58e047f-1530-4c20-be80-ab4596421867', 'tenant-a2', 'embed', '{"memoryId": "663d79c0-8de7-4b0d-8b9e-161a947bc954"}', '2026-09-27 06:47:05.496143+09', '2026-09-27 06:47:05.532+09', 'runtime.tick', 1, '2026-09-27 06:47:05.567416+09', NULL, NULL, '2026-09-27 06:47:05.496143+09');
INSERT INTO public.outbox VALUES ('97e34342-4e01-4e7f-9246-1a04777471f7', 'tenant-a2', 'embed', '{"memoryId": "71a462b3-bbbd-4382-9bc3-6f02244ea4ed"}', '2026-09-27 06:47:05.501582+09', '2026-09-27 06:47:05.532+09', 'runtime.tick', 1, '2026-09-27 06:47:05.571795+09', NULL, NULL, '2026-09-27 06:47:05.501582+09');
INSERT INTO public.outbox VALUES ('c235a4e2-7725-4253-be83-d81b8cea1835', 'tenant-a2', 'embed', '{"memoryId": "b41b86fd-7f83-43c4-8230-de53e8cf2435"}', '2026-09-27 06:47:05.506815+09', '2026-09-27 06:47:05.532+09', 'runtime.tick', 1, '2026-09-27 06:47:05.594853+09', NULL, NULL, '2026-09-27 06:47:05.506815+09');
INSERT INTO public.outbox VALUES ('af379d75-22c2-4e51-9341-154d4b9eebd0', 'tenant-a2', 'embed', '{"memoryId": "e5e2ff1e-c44c-413d-8396-e93c413c983d"}', '2026-09-27 06:47:05.528515+09', '2026-09-27 06:47:05.532+09', 'runtime.tick', 1, NULL, '2026-09-27 06:47:05.598944+09', 'fixture: embedding provider failure', '2026-09-27 06:47:05.528515+09');
INSERT INTO public.outbox VALUES ('0d72c5e7-8787-4893-9894-2990ddf5cdc3', 'tenant-a2', 'embed', '{"memoryId": "36927efd-7c78-4194-b1d8-ef20806185a0"}', '2026-09-27 06:47:05.603378+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 06:47:05.603378+09');
INSERT INTO public.outbox VALUES ('9dca149c-7fbc-4982-96f4-8cbbd032bc0a', 'tenant-a2', 'extract', '{"observationId": "0c15739e-1b43-4d52-9b78-945486a3165d"}', '2026-09-27 06:47:05.600281+09', NULL, NULL, 0, '2026-09-27 06:47:05.606798+09', NULL, NULL, '2026-09-27 06:47:05.600281+09');
INSERT INTO public.outbox VALUES ('0402382b-83a3-41bf-a224-6a5f00df33a4', 'tenant-a2', 'embed', '{"memoryId": "85ffcbdc-c509-4a19-b40f-b20701b86538"}', '2026-09-27 06:47:05.610101+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 06:47:05.610101+09');
INSERT INTO public.outbox VALUES ('a743e890-af7d-486a-bf1c-521e744ead6d', 'tenant-a2', 'extract', '{"observationId": "113280e5-d14c-4d3c-b34a-717ac73f530b"}', '2026-09-27 06:47:05.607613+09', NULL, NULL, 0, '2026-09-27 06:47:05.613605+09', NULL, NULL, '2026-09-27 06:47:05.607613+09');
INSERT INTO public.outbox VALUES ('287176e9-4a45-4a64-937f-aa0e43fe0cdd', 'tenant-a2', 'embed', '{"memoryId": "ad7bdf2d-6509-4805-958f-f5a36bb2cbd2"}', '2026-09-27 06:47:05.616697+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-27 06:47:05.616697+09');
INSERT INTO public.outbox VALUES ('45b01e7d-1db7-49e9-a0fd-4dbd3a7cc809', 'tenant-a2', 'extract', '{"observationId": "3f2110c9-4c4e-4ead-9730-8c6c547dd03f"}', '2026-09-27 06:47:05.61456+09', NULL, NULL, 0, '2026-09-27 06:47:05.619844+09', NULL, NULL, '2026-09-27 06:47:05.61456+09');


--
-- Data for Name: recall_usages; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.recall_usages VALUES ('tenant-a', '0e363499-072d-409c-9dab-589d2e6aaa21', '7fcf19ee-0459-4cd2-aafa-5e8f461a1b01', '2026-09-27 06:47:04.574256+09');
INSERT INTO public.recall_usages VALUES ('tenant-b', '32ab5061-34cc-42e1-8d99-4f0fac56729e', '6b663b08-a3b9-47c1-877f-437136fab799', '2026-09-27 06:47:05.004601+09');
INSERT INTO public.recall_usages VALUES ('tenant-c', 'ff67ef95-26a0-4ff6-9498-b03e1e5e89cc', 'c423022b-93bf-40d5-a507-6430f41caba8', '2026-09-27 06:47:05.421153+09');
INSERT INTO public.recall_usages VALUES ('tenant-a2', '74800cb8-49a9-48e1-b344-e7c96e2a5ca8', '7a31e516-db8c-4770-bef1-636a6939e8ce', '2026-09-27 06:47:05.648977+09');


--
-- Data for Name: recalls; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.recalls VALUES ('0e363499-072d-409c-9dab-589d2e6aaa21', 'tenant-a', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 2, "countKind": "exact"}, {"kind": "over_limit", "count": 13, "stage": "rescore", "countKind": "exact"}, {"kind": "ann_truncated", "certainty": "undecidable", "countKind": "unknown", "undecidableReason": "ANN が返した最後の similarity が 0 以下または非有限である（NaN）。この場合、上界の不等式は total の順序を保証しない。"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 2, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 2063, "byTier": {"full": 0, "index": 1918, "digest": 145}, "counter": "heuristic", "indexChars": 1918, "estimatedTokens": 701}', '{"groups": [{"key": null, "axis": "subject", "count": 24, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-a 未埋め込み 2", "memoryId": "b2035fac-a734-43ba-b5cc-f10c27817910"}, {"digest": "tenant-a 未埋め込み 1", "memoryId": "a2ee63d6-f330-42aa-a2ab-fd96a7562c31"}, {"digest": "tenant-a 未埋め込み 0", "memoryId": "36a018b7-2baa-4cb8-8ab4-090c046e3e96"}, {"digest": "tenant-a FAIL 埋め込み失敗 東京", "memoryId": "750c1584-6606-4c4a-b1c3-18011d4271da"}, {"digest": "tenant-a の記憶 23 東京 会議 プロジェクト3", "memoryId": "be6f5c44-8a10-4240-aa12-7bda7fab6b5c"}, {"digest": "tenant-a の記憶 19 東京 会議 プロジェクト4", "memoryId": "6eb13a38-d170-4dde-a76e-abcd9787bd78"}, {"digest": "tenant-a の記憶 18 東京 会議 プロジェクト3", "memoryId": "1dce5856-2828-44f3-b941-a11b1b9aaa35"}, {"digest": "tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO", "memoryId": "b9be8551-2c8c-458e-a645-539c7b271415"}, {"digest": "tenant-a の記憶 16 東京 会議 プロジェクト1", "memoryId": "86b07ad9-c438-4798-a7d2-5117484e7108"}, {"digest": "tenant-a の記憶 14 東京 会議 プロジェクト4", "memoryId": "0cba8cd1-efff-426e-a281-288ac550bb0f"}, {"digest": "tenant-a の記憶 13 東京 会議 プロジェクト3", "memoryId": "99944142-5307-4131-a395-4bd0807c43c5"}, {"digest": "tenant-a の記憶 8 東京 会議 プロジェクト3", "memoryId": "832a490f-cf53-43db-b433-359c0ce7c5b3"}, {"digest": "tenant-a の記憶 7 東京 会議 プロジェクト2", "memoryId": "8270bfec-5d3f-42e1-ba2b-4ae7ed4e1021"}, {"digest": "tenant-a の記憶 6 東京 会議 プロジェクト1", "memoryId": "3eaafd2a-7b9d-4528-a456-aefa9334dced"}, {"digest": "tenant-a の記憶 5 東京 会議 プロジェクト0", "memoryId": "66efbfcd-434a-47ae-a9aa-e887b86be1c0"}, {"digest": "tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "225c787d-5262-477b-bc1b-34654cb65de6"}, {"digest": "tenant-a の記憶 2 東京 会議 プロジェクト2", "memoryId": "4524e767-7d53-4d56-afee-7c179d73cff5"}, {"digest": "tenant-a の記憶 1 東京 会議 プロジェクト1", "memoryId": "c5019fa5-7e78-4d8d-9feb-a3cdcfc52526"}, {"digest": "tenant-a の記憶 0 東京 会議 プロジェクト0", "memoryId": "067e442f-f09a-4ebf-9968-33c232e62204"}], "totalInScope": 24, "digestBandCoverage": {"shown": 19, "eligible": 19, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-09-26T21:47:04.544Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 20, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 20, "withinLimit": 5, "notComparable": 2, "passedThreshold": 18}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 0}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 5, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 24}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-27 06:47:04.560774+09', '{"memories": [{"score": {"decay": 0.9999998933002661, "total": 0.7063610567110952, "strength": 1, "tagMatch": 1, "freshness": 0.9999998933002661, "similarity": 0.7063612074481929, "affinityMeasured": true}, "memoryId": "7fcf19ee-0459-4cd2-aafa-5e8f461a1b01", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999034621451, "total": 0.7058284168150838, "strength": 1, "tagMatch": 1, "freshness": 0.9999999034621451, "similarity": 0.7058285530934261, "affinityMeasured": true}, "memoryId": "0835061e-e52f-43b1-b7ce-dc9f24f015d7", "retrievedVia": "ann"}, {"score": {"decay": 0.9999998729765085, "total": 0.7057909015047221, "strength": 1, "tagMatch": 1, "freshness": 0.9999998729765085, "similarity": 0.7057910808088055, "affinityMeasured": true}, "memoryId": "a5ba9494-0185-4a75-be8c-3fe7e27cb290", "retrievedVia": "ann"}, {"score": {"decay": 0.9999998585359442, "total": 0.7056452405735898, "strength": 1, "tagMatch": 1, "freshness": 0.9999998585359442, "similarity": 0.7056454402205076, "affinityMeasured": true}, "memoryId": "a2be48c4-6b6f-4f8e-a5bb-76911530e005", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999064037416, "total": 0.7052961554906902, "strength": 1, "tagMatch": 1, "freshness": 0.9999999064037416, "similarity": 0.7052962875168712, "affinityMeasured": true}, "memoryId": "aa907ddf-3b5d-400e-b915-c43a6f7af18e", "retrievedVia": "ann"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('32ab5061-34cc-42e1-8d99-4f0fac56729e', 'tenant-b', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 2, "countKind": "exact"}, {"kind": "over_limit", "count": 6, "stage": "rescore", "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 3, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 1413, "byTier": {"full": 0, "index": 1268, "digest": 145}, "counter": "heuristic", "indexChars": 1268, "estimatedTokens": 480}', '{"groups": [{"key": null, "axis": "subject", "count": 17, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-b 未埋め込み 2", "memoryId": "65dcf125-5efb-4566-9735-57d445b78547"}, {"digest": "tenant-b 未埋め込み 1", "memoryId": "2c995ff0-846b-470b-9d57-7d41ba1e4e25"}, {"digest": "tenant-b 未埋め込み 0", "memoryId": "7764b9f6-9eb7-4370-bfca-1197c5964425"}, {"digest": "tenant-b FAIL 埋め込み失敗 東京", "memoryId": "492cdfac-fada-43de-9cde-ca890ec1f88d"}, {"digest": "tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO", "memoryId": "84a40b66-54af-4eea-9777-4b7c47a2ec64"}, {"digest": "tenant-b の記憶 7 東京 会議 プロジェクト2", "memoryId": "77f282a1-d45c-4f7e-b003-a80deaa55028"}, {"digest": "tenant-b の記憶 6 東京 会議 プロジェクト1", "memoryId": "290d95d6-4c0b-4562-988d-b823f1cd16a6"}, {"digest": "tenant-b の記憶 5 東京 会議 プロジェクト0", "memoryId": "b9d95781-0306-4f16-970b-a6407dbf43d5"}, {"digest": "tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "70d9d481-0c24-419d-8b8c-9c799ae20937"}, {"digest": "tenant-b の記憶 2 東京 会議 プロジェクト2", "memoryId": "655eec4c-c86e-4e79-a9c6-272dd91956ae"}, {"digest": "tenant-b の記憶 1 東京 会議 プロジェクト1", "memoryId": "05339903-a1c8-4d2e-9ab2-b5076861c246"}, {"digest": "tenant-b の記憶 0 東京 会議 プロジェクト0", "memoryId": "17bbbe8b-48ca-477d-9f23-ee0824a28178"}], "totalInScope": 17, "digestBandCoverage": {"shown": 12, "eligible": 12, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-09-26T21:47:04.995Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 13, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 13, "withinLimit": 5, "notComparable": 2, "passedThreshold": 11}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 0}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 5, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 17}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-27 06:47:05.001233+09', '{"memories": [{"score": {"decay": 0.9999999315410215, "total": 0.6564809518764364, "strength": 1, "tagMatch": 1, "freshness": 0.9999999315410215, "similarity": 0.6564810417604764, "affinityMeasured": true}, "memoryId": "6b663b08-a3b9-47c1-877f-437136fab799", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999299365143, "total": 0.6564711816151811, "strength": 1, "tagMatch": 1, "freshness": 0.9999999299365143, "similarity": 0.6564712736045092, "affinityMeasured": true}, "memoryId": "457bce5f-e77d-4b92-8d18-e37d9f632477", "retrievedVia": "ann"}, {"score": {"decay": 0.999999928332007, "total": 0.6564611725271676, "strength": 1, "tagMatch": 1, "freshness": 0.999999928332007, "similarity": 0.6564612666216871, "affinityMeasured": true}, "memoryId": "ac7309cc-d0ce-4b13-83f4-94685cc6c8b7", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999422377366, "total": 0.6554165427876734, "strength": 1, "tagMatch": 1, "freshness": 0.9999999422377366, "similarity": 0.6554166185043658, "affinityMeasured": true}, "memoryId": "5e63de98-905a-4fb3-8e65-45bd5c514b3c", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999398309757, "total": 0.655406025851956, "strength": 1, "tagMatch": 1, "freshness": 0.9999999398309757, "similarity": 0.6554061047222453, "affinityMeasured": true}, "memoryId": "16ac3149-2d51-4a65-8d1e-9fb359eab713", "retrievedVia": "ann"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('ff67ef95-26a0-4ff6-9498-b03e1e5e89cc', 'tenant-c', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 1, "countKind": "exact"}, {"kind": "over_limit", "count": 1, "stage": "rescore", "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 3, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 784, "byTier": {"full": 0, "index": 616, "digest": 168}, "counter": "heuristic", "indexChars": 616, "estimatedTokens": 272}', '{"groups": [{"key": null, "axis": "subject", "count": 11, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-c 未埋め込み 2", "memoryId": "faa17efc-d683-42fe-bc28-4720ea837a52"}, {"digest": "tenant-c 未埋め込み 1", "memoryId": "1ec5034e-fd0e-4d63-bd8f-26843d448006"}, {"digest": "tenant-c 未埋め込み 0", "memoryId": "6e9d888c-c626-474d-900c-29ddbef80fef"}, {"digest": "tenant-c FAIL 埋め込み失敗 東京", "memoryId": "27c504ea-4489-41ee-b6a0-d402b449ee6f"}, {"digest": "tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "bf117f84-8fef-4dba-ad41-516b81ce1649"}], "totalInScope": 11, "digestBandCoverage": {"shown": 5, "eligible": 5, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-09-26T21:47:05.411Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 7, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 7, "withinLimit": 5, "notComparable": 1, "passedThreshold": 6}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 1}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 5, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 11}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-27 06:47:05.418007+09', '{"memories": [{"score": {"decay": 0.9999999034621451, "total": 0.544669839415306, "strength": 1, "tagMatch": 1, "freshness": 0.9999999034621451, "similarity": 0.5446699445778371, "affinityMeasured": true}, "memoryId": "c423022b-93bf-40d5-a507-6430f41caba8", "retrievedVia": "ann"}, {"score": {"decay": 0.999999901322802, "total": 0.5442744858184724, "strength": 1, "tagMatch": 1, "freshness": 0.999999901322802, "similarity": 0.5442745932334506, "affinityMeasured": true}, "memoryId": "1b9b19b9-a36c-42f6-ad73-dd1be3956fd1", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999296690965, "total": 0.5442010412248041, "strength": 1, "tagMatch": 1, "freshness": 0.9999999296690965, "similarity": 0.544201117773114, "affinityMeasured": true}, "memoryId": "78a6562a-224a-4cdc-a0ec-a01f70aa92f8", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999248555747, "total": 0.999999849711155, "strength": 1, "tagMatch": 1, "freshness": 0.9999999248555747, "affinityMeasured": false}, "memoryId": "b05cf74d-9056-48d6-a7c3-fe9f92fe311a", "companionOf": "78a6562a-224a-4cdc-a0ec-a01f70aa92f8", "retrievedVia": "mandatory_companion"}, {"score": {"decay": 0.9999998991834591, "total": 0.5438774973830137, "strength": 1, "tagMatch": 1, "freshness": 0.9999998991834591, "similarity": 0.5438776070467263, "affinityMeasured": true}, "memoryId": "f74f1a5e-9254-4da2-b201-793f4a707663", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999280645891, "total": 0.5438076066827009, "strength": 1, "tagMatch": 1, "freshness": 0.9999999280645891, "similarity": 0.5438076849207566, "affinityMeasured": true}, "memoryId": "10563ca6-bc9c-48ba-9f6c-405444cfc9cb", "retrievedVia": "ann"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('74800cb8-49a9-48e1-b344-e7c96e2a5ca8', 'tenant-a2', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 1, "countKind": "exact"}, {"kind": "over_limit", "count": 2, "stage": "rescore", "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 2, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 726, "byTier": {"full": 0, "index": 552, "digest": 174}, "counter": "heuristic", "indexChars": 552, "estimatedTokens": 259}', '{"groups": [{"key": null, "axis": "subject", "count": 10, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-a2 未埋め込み 2", "memoryId": "ad7bdf2d-6509-4805-958f-f5a36bb2cbd2"}, {"digest": "tenant-a2 FAIL 埋め込み失敗 東京", "memoryId": "e5e2ff1e-c44c-413d-8396-e93c413c983d"}, {"digest": "tenant-a2 の記憶 5 東京 会議 プロジェクト0", "memoryId": "78d7dd8f-9d66-44e9-b0f6-e12e21fa9701"}, {"digest": "tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "58208bdb-901d-4dbb-bb18-191dca147cad"}], "totalInScope": 10, "digestBandCoverage": {"shown": 4, "eligible": 4, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-09-26T21:47:05.636Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 8, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 8, "withinLimit": 5, "notComparable": 1, "passedThreshold": 7}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 1}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 5, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 10}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-27 06:47:05.646342+09', '{"memories": [{"score": {"decay": 0.9999999540041233, "total": 0.3296480561265252, "strength": 1, "tagMatch": 1, "freshness": 0.9999999540041233, "similarity": 0.32964808645142996, "affinityMeasured": true}, "memoryId": "7a31e516-db8c-4770-bef1-636a6939e8ce", "retrievedVia": "ann"}, {"score": {"decay": 0.999999963898585, "total": 0.3295125126188719, "strength": 1, "tagMatch": 1, "freshness": 0.999999963898585, "similarity": 0.32951253641060907, "affinityMeasured": true}, "memoryId": "71a462b3-bbbd-4382-9bc3-6f02244ea4ed", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999612244062, "total": 0.9999999224488139, "strength": 1, "tagMatch": 1, "freshness": 0.9999999612244062, "affinityMeasured": false}, "memoryId": "de88d53a-db55-4df4-a95e-13076083d22f", "companionOf": "71a462b3-bbbd-4382-9bc3-6f02244ea4ed", "retrievedVia": "mandatory_companion"}, {"score": {"decay": 0.9999999449119155, "total": 0.3292026150011589, "strength": 1, "tagMatch": 1, "freshness": 0.9999999449119155, "similarity": 0.3292026512714449, "affinityMeasured": true}, "memoryId": "24540d97-3daa-4014-9128-0819f6fba9db", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999622940777, "total": 0.3290689812759072, "strength": 1, "tagMatch": 1, "freshness": 0.9999999622940777, "similarity": 0.3290690060916075, "affinityMeasured": true}, "memoryId": "663d79c0-8de7-4b0d-8b9e-161a947bc954", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999438422439, "total": 0.3287565236554792, "strength": 1, "tagMatch": 1, "freshness": 0.9999999438422439, "similarity": 0.3287565605799396, "affinityMeasured": true}, "memoryId": "c2cbb566-6b1c-40b0-8091-b7eb4723754a", "retrievedVia": "ann"}], "breakdownCaptured": true}');


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


