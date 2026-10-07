-- 公開済みの版 v1.3.0 で作った DB の fixture（ADR 0344）。
-- ⛔ 手で編集しない。作り直すときは scripts/generate-upgrade-fixture.mjs を走らせる。
--
-- 作ったコード: v1.3.0（d811241f813e413af91d055f5f8211d2b8f82818）の @mnemora/postgres / @mnemora/core / @mnemora/testkit。
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
    SELECT websearch_to_tsquery('simple', '"' || replace(t, '"', ' ') || '"') AS q
    FROM unnest(regexp_split_to_array(btrim(mnemora_lexical_query_terms($1)), '\s+')) AS t
    WHERE t <> ''
  ) s
  WHERE q::text <> '';
$_$;


--
-- Name: mnemora_lexical_tsvector(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_tsvector(content text) RETURNS tsvector
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN to_tsvector('simple', mnemora_lexical_normalize(content));
EXCEPTION WHEN program_limit_exceeded THEN
  IF SQLERRM NOT LIKE '%too long for tsvector%' THEN
    RAISE;
  END IF;
  RETURN to_tsvector('simple', mnemora_lexical_normalize(left(content, 150000)));
END;
$$;


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
-- Name: TABLE memory_embeddings_test_fixture_model_3; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.memory_embeddings_test_fixture_model_3 IS 'mnemora:embedding-space:{"provider":"test","model":"fixture-model","dimensions":3}';


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
-- Name: TABLE memory_embeddings_testkit_deterministic_8; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.memory_embeddings_testkit_deterministic_8 IS 'mnemora:embedding-space:{"provider":"testkit","model":"deterministic","dimensions":8}';


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
-- Name: TABLE memory_embeddings_some_very_long_provider_name_an_extr_b34ef257; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 IS 'mnemora:embedding-space:{"provider":"some-very-long-provider-name","model":"an-extremely-long-embedding-model-name-v2-large","dimensions":4}';


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
-- Name: memory_relations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_relations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    from_memory_id uuid NOT NULL,
    to_memory_id uuid NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_relations_kind_check CHECK ((kind = 'contradicts'::text))
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
-- Name: tenant_subject_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_subject_activity (
    tenant_id text NOT NULL,
    subject_id text NOT NULL,
    activity_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_subject_activity_seq_non_negative CHECK ((activity_seq >= 0))
);


--
-- Data for Name: _mnemora_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public._mnemora_migrations VALUES ('0001_init.sql', '2026-10-07 19:12:51.55149+09');
INSERT INTO public._mnemora_migrations VALUES ('0002_outbox_claim_lease_index.sql', '2026-10-07 19:12:51.568291+09');
INSERT INTO public._mnemora_migrations VALUES ('0003_period_ann_stage_index.sql', '2026-10-07 19:12:51.569532+09');
INSERT INTO public._mnemora_migrations VALUES ('0004_contested_with_index.sql', '2026-10-07 19:12:51.570912+09');
INSERT INTO public._mnemora_migrations VALUES ('0005_analyze_memories.sql', '2026-10-07 19:12:51.572685+09');
INSERT INTO public._mnemora_migrations VALUES ('0006_strength_value_range.sql', '2026-10-07 19:12:51.574205+09');
INSERT INTO public._mnemora_migrations VALUES ('0007_memories_requeue_embed_index.sql', '2026-10-07 19:12:51.575626+09');
INSERT INTO public._mnemora_migrations VALUES ('0008_memories_lexical_index.sql', '2026-10-07 19:12:51.577332+09');
INSERT INTO public._mnemora_migrations VALUES ('0009_memories_lexical_or_coverage.sql', '2026-10-07 19:12:51.579848+09');
INSERT INTO public._mnemora_migrations VALUES ('0010_memory_events_retention_index.sql', '2026-10-07 19:12:51.581625+09');
INSERT INTO public._mnemora_migrations VALUES ('0011_memory_events_kind_restored.sql', '2026-10-07 19:12:51.582889+09');
INSERT INTO public._mnemora_migrations VALUES ('0012_half_life_hours_range.sql', '2026-10-07 19:12:51.585704+09');
INSERT INTO public._mnemora_migrations VALUES ('0013_recall_returned_memories_jsonb.sql', '2026-10-07 19:12:51.586879+09');
INSERT INTO public._mnemora_migrations VALUES ('0014_observations_valid_from_until.sql', '2026-10-07 19:12:51.589175+09');
INSERT INTO public._mnemora_migrations VALUES ('0015_decay_activity_clock.sql', '2026-10-07 19:12:51.5905+09');
INSERT INTO public._mnemora_migrations VALUES ('0016_provenance_kind_matches_provenance.sql', '2026-10-07 19:12:51.594152+09');
INSERT INTO public._mnemora_migrations VALUES ('0017_provenance_kind_matches_provenance_validate.sql', '2026-10-07 19:12:51.595887+09');
INSERT INTO public._mnemora_migrations VALUES ('0018_memory_events_kind_unsuperseded.sql', '2026-10-07 19:12:51.596602+09');
INSERT INTO public._mnemora_migrations VALUES ('0019_observations_memories_attributes.sql', '2026-10-07 19:12:51.598483+09');
INSERT INTO public._mnemora_migrations VALUES ('0020_taxonomy_labels.sql', '2026-10-07 19:12:51.600156+09');
INSERT INTO public._mnemora_migrations VALUES ('0021_memories_claim_key.sql', '2026-10-07 19:12:51.608083+09');
INSERT INTO public._mnemora_migrations VALUES ('0022_embedding_zero_norm_index.sql', '2026-10-07 19:12:51.60989+09');
INSERT INTO public._mnemora_migrations VALUES ('0023_lexical_query_inner_quote_as_space.sql', '2026-10-07 19:12:51.620552+09');
INSERT INTO public._mnemora_migrations VALUES ('0024_tenant_subject_activity.sql', '2026-10-07 19:12:51.625886+09');
INSERT INTO public._mnemora_migrations VALUES ('0025_lexical_tsvector_fallback.sql', '2026-10-07 19:12:51.628268+09');
INSERT INTO public._mnemora_migrations VALUES ('0026_memory_relations.sql', '2026-10-07 19:12:51.630162+09');
INSERT INTO public._mnemora_migrations VALUES ('0027_erase_tenant_fk_indexes.sql', '2026-10-07 19:12:51.632939+09');
INSERT INTO public._mnemora_migrations VALUES ('0028_digest_band_index.sql', '2026-10-07 19:12:51.64043+09');
INSERT INTO public._mnemora_migrations VALUES ('0029_memories_claim_predicates_index.sql', '2026-10-07 19:12:51.644833+09');
INSERT INTO public._mnemora_migrations VALUES ('0030_recalls_digest_band_index.sql', '2026-10-07 19:12:51.647907+09');
INSERT INTO public._mnemora_migrations VALUES ('0031_memory_labels_label_id_index.sql', '2026-10-07 19:12:51.649237+09');
INSERT INTO public._mnemora_migrations VALUES ('0032_purge_indexes.sql', '2026-10-07 19:12:51.651226+09');


--
-- Data for Name: labels; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: memories; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memories VALUES ('7758338c-58cb-4fc7-8bbe-1392d468e32c', 'tenant-a', NULL, 'daae69af-69c0-45ff-99b8-4972d5ce6e45', 'v1', 'tenant-a の記憶 1 東京 会議 プロジェクト1', 'ed6b6174b16e829904eb19e37af61bcdac066ad24d037aab65ab91746f903e4e', 'tenant-a の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.700Z", "kind": "stated", "speaker": "user", "sourceObservationId": "daae69af-69c0-45ff-99b8-4972d5ce6e45"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.702+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.323+09', 'ready', NULL, '2026-10-07 19:12:51.703457+09', '2026-10-07 19:12:51.873573+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('9e5e0ceb-69d0-4469-9673-6d333ffe6575', 'tenant-a', NULL, '1d2d9caf-692c-4577-90d9-2db4913c712a', 'v1', 'tenant-a の記憶 2 東京 会議 プロジェクト2', 'd5783633ec67bfa023b1656bde0eda60589e932b2e5eb00bad51d9366c647db5', 'tenant-a の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.708Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1d2d9caf-692c-4577-90d9-2db4913c712a"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.709+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.33+09', 'ready', NULL, '2026-10-07 19:12:51.710074+09', '2026-10-07 19:12:51.87681+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b0ebb353-77af-487e-bc5e-644be85d3c7a', 'tenant-a', NULL, 'b52ba63f-4a71-4e7b-af72-234d39a0095b', 'v1', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', 'd6d0bf800f00f3c35af37625f3533767a4db7afbdc77fe18c3bc2d5987ba70c1', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.713Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b52ba63f-4a71-4e7b-af72-234d39a0095b"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.715+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.336+09', 'ready', NULL, '2026-10-07 19:12:51.715756+09', '2026-10-07 19:12:51.880196+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('58ec7654-8f38-4c2e-adb6-309bccf32956', 'tenant-a', NULL, '97d65c31-acfc-4a7b-8627-60eefe64e758', 'v1', 'tenant-a の記憶 5 東京 会議 プロジェクト0', 'edf34c29245092db70ab98057250239de4f569a113efa424ebda0f9cd882bd55', 'tenant-a の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.724Z", "kind": "stated", "speaker": "user", "sourceObservationId": "97d65c31-acfc-4a7b-8627-60eefe64e758"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.726+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.347+09', 'ready', NULL, '2026-10-07 19:12:51.726497+09', '2026-10-07 19:12:51.88709+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('fcd8b5e4-3c5e-41ea-bbaa-0817d76d824c', 'tenant-a', NULL, '29fcb6f2-0517-425f-b85e-caa82d1814a3', 'v1', 'tenant-a の記憶 7 東京 会議 プロジェクト2', '0c60f6ec18ba3a28b875b6830e0201a28a0ce0a0831c5c1cfa14d9213f4fccc3', 'tenant-a の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.746Z", "kind": "stated", "speaker": "user", "sourceObservationId": "29fcb6f2-0517-425f-b85e-caa82d1814a3"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.747+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.368+09', 'ready', NULL, '2026-10-07 19:12:51.748329+09', '2026-10-07 19:12:51.894584+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c8a9eeb5-ed23-4c73-9df3-a30482aa550f', 'tenant-a', NULL, 'ecfa5245-ce1d-407c-824d-c1a1164961cf', 'v1', 'tenant-a の記憶 12 東京 会議 プロジェクト2', '1416843979dca4b10e813c98b42e4e64184da19a8246431ca987465bf0319a69', 'tenant-a の記憶 12 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.781Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ecfa5245-ce1d-407c-824d-c1a1164961cf"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.784+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.405+09', 'ready', NULL, '2026-10-07 19:12:51.784906+09', '2026-10-07 19:12:51.921496+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1f155584-eb38-4b19-a539-45252c8b2d02', 'tenant-a', NULL, 'bda1a8c6-709a-4900-b090-7ccd8b64e030', 'v1', 'tenant-a の記憶 13 東京 会議 プロジェクト3', '85fa57655dee036fb504dc9e026f2dfe383c1140f5fab5d93ff65f97a76f63c1', 'tenant-a の記憶 13 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.788Z", "kind": "stated", "speaker": "user", "sourceObservationId": "bda1a8c6-709a-4900-b090-7ccd8b64e030"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.791+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.412+09', 'ready', NULL, '2026-10-07 19:12:51.791596+09', '2026-10-07 19:12:51.924936+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('66a39a9a-cee2-4d2a-83d1-e74a795f2069', 'tenant-a', NULL, '03427a62-292e-45ba-9967-f214dadd233c', 'v1', 'tenant-a の記憶 14 東京 会議 プロジェクト4', '566c00e514039c3cbdde42ca12af98244b4fc1d1fba5c31799c41667ccb84955', 'tenant-a の記憶 14 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.795Z", "kind": "stated", "speaker": "user", "sourceObservationId": "03427a62-292e-45ba-9967-f214dadd233c"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.797+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.418+09', 'ready', NULL, '2026-10-07 19:12:51.798474+09', '2026-10-07 19:12:51.928196+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ae8e9716-84e9-47f3-a501-596a9b524ff5', 'tenant-a', NULL, 'e516bf03-b0d5-4104-9048-17b22e32b58e', 'v1', 'tenant-a の記憶 15 東京 会議 プロジェクト0', 'f0b29bf3fc257d56d53bf3a40509a30894afa7846eb7397ab547ea18a3a29c38', 'tenant-a の記憶 15 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.803Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e516bf03-b0d5-4104-9048-17b22e32b58e"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.806+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.427+09', 'ready', NULL, '2026-10-07 19:12:51.806779+09', '2026-10-07 19:12:51.931452+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a5a0aa63-a181-43dd-966b-c2d7b2e8b773', 'tenant-a', NULL, '0ec8b0b8-af1a-4b9e-b53f-aa73944085b1', 'v1', 'tenant-a の記憶 4 東京 会議 プロジェクト4', '2d4011873ef8b25d39bde2a8122f185e9e032a938e8e1020e527a073b0930df3', 'tenant-a の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.719Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0ec8b0b8-af1a-4b9e-b53f-aa73944085b1"}', 'superseded', '58ec7654-8f38-4c2e-adb6-309bccf32956', NULL, '{}', NULL, '2026-10-07 19:12:51.72+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.341+09', 'ready', NULL, '2026-10-07 19:12:51.72112+09', '2026-10-07 19:12:51.995194+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('01767b15-4fd2-438b-86d7-ac0312ea6421', 'tenant-a', NULL, '8e4b04ea-597a-44f0-8f27-0d7bbfdc3f78', 'v1', 'tenant-a の記憶 6 東京 会議 プロジェクト1', 'd930b5a8cf81e3b3b32791e8dae3c05994da72ef1265c035dfaf39080ed62dbe', 'tenant-a の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.735Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8e4b04ea-597a-44f0-8f27-0d7bbfdc3f78"}', 'contested', NULL, '3aad2359-9ce5-47d3-8499-3d122b931d75', '{}', NULL, '2026-10-07 19:12:51.738+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.359+09', 'ready', NULL, '2026-10-07 19:12:51.738737+09', '2026-10-07 19:12:51.998157+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('aeb13a03-10a2-42c9-8a8f-31bd47e15b05', 'tenant-a', NULL, '90008bba-3ae4-4f0a-bfc4-69037c3e0a1f', 'v1', 'tenant-a の記憶 9 東京 会議 プロジェクト4', '4c241e9f2abb28b016af405d09bb673284fc201c4fac4a039faba6f8c7e22fc3', 'tenant-a の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.759Z", "kind": "stated", "speaker": "user", "sourceObservationId": "90008bba-3ae4-4f0a-bfc4-69037c3e0a1f"}', 'archived', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.761+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.382+09', 'ready', NULL, '2026-10-07 19:12:51.762058+09', '2026-10-07 19:12:52.003284+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6ce3006a-5038-44f3-95b0-37cce6eb5b81', 'tenant-a', NULL, 'd47f19f5-8844-4f8c-b833-26651e293018', 'v1', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', 'f43c8e3670dc49dcd5e7d3d4067e6675ad27bf370e403c97f646b08db859894f', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.765Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d47f19f5-8844-4f8c-b833-26651e293018"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.768+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.389+09', 'ready', NULL, '2026-10-07 19:12:51.770464+09', '2026-10-07 19:12:52.005831+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('28d469b7-5c04-42f8-b519-b9d6fd6fd888', 'tenant-a', NULL, '2a28d662-ebf6-4f86-b4fd-567127d47e80', 'v1', '[purged]', '8baacaa745d740261839f6dbe908954009bba75aead9ea0901933a52379e09f4', '[purged]', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.775Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2a28d662-ebf6-4f86-b4fd-567127d47e80"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.776+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.397+09', 'ready', '2026-10-07 19:12:52.011+09', '2026-10-07 19:12:51.77753+09', '2026-10-07 19:12:52.012467+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('2fbb63f9-0722-4677-bab2-8d3b7533f9f8', 'tenant-a', NULL, '9d1710c8-c82d-4418-a3b2-b4939e87f704', 'v1', 'tenant-a の記憶 0 東京 会議 プロジェクト0', 'd3ea19d3736314cb9c467c1662164327f232b7f4614ea76f675772f69c277594', 'tenant-a の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.678Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9d1710c8-c82d-4418-a3b2-b4939e87f704"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.687+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.308+09', 'ready', NULL, '2026-10-07 19:12:51.689009+09', '2026-10-07 19:12:51.869884+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a877a726-3af7-4c82-9e2e-074cd07ab8cb', 'tenant-a', NULL, 'a66c556d-2f87-47f0-ad6d-53ae2a7cba68', 'v1', 'tenant-a の記憶 16 東京 会議 プロジェクト1', 'ca52ff79646f23e88b31f2cd9bab84db866daa8ee904c6ffc4f2608348e05082', 'tenant-a の記憶 16 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.810Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a66c556d-2f87-47f0-ad6d-53ae2a7cba68"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.812+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.433+09', 'ready', NULL, '2026-10-07 19:12:51.812724+09', '2026-10-07 19:12:51.934947+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b7adc42b-6c36-489a-abd9-318425688272', 'tenant-a', NULL, '1c16d7b9-77db-4492-a4c2-b0a87c3bb3c2', 'v1', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', 'b143762528afffbb72a33fb24f70ebd4d19cd0cc89719dd7231a45971896fde7', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.816Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1c16d7b9-77db-4492-a4c2-b0a87c3bb3c2"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.817+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.438+09', 'ready', NULL, '2026-10-07 19:12:51.818027+09', '2026-10-07 19:12:51.937857+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f164a835-0ac4-48e1-a09d-4e2b161b1ce1', 'tenant-a', NULL, '7807148b-fd04-4d27-b84f-1030e74e1a55', 'v1', 'tenant-a の記憶 18 東京 会議 プロジェクト3', '6d3a158a624537a869f95ca05e650119d80bbe0cd4f796b22bc3c31ea83ada8a', 'tenant-a の記憶 18 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.821Z", "kind": "stated", "speaker": "user", "sourceObservationId": "7807148b-fd04-4d27-b84f-1030e74e1a55"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.822+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.443+09', 'ready', NULL, '2026-10-07 19:12:51.823341+09', '2026-10-07 19:12:51.940723+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a800507b-204e-4829-9160-ebd0e307c892', 'tenant-a', NULL, 'ae8fee43-0288-436f-9286-f00ad62bc188', 'v1', 'tenant-a の記憶 19 東京 会議 プロジェクト4', '83b96ac18e746f06f8c77902fd8d7e7f3c59541caaa6ae2658298580ec04e043', 'tenant-a の記憶 19 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.826Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ae8fee43-0288-436f-9286-f00ad62bc188"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.828+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.449+09', 'ready', NULL, '2026-10-07 19:12:51.828418+09', '2026-10-07 19:12:51.945947+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('09d4c803-84ed-45fb-8cd9-2342917e0943', 'tenant-a', NULL, 'a5b6653b-8006-4503-bfa4-7c179e6c90fc', 'v1', 'tenant-a の記憶 21 東京 会議 プロジェクト1', '4c3e66f819f467c96c28794801e751d2d4f6a9e3cd240dcfc9c3bf55c1cacc57', 'tenant-a の記憶 21 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.836Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a5b6653b-8006-4503-bfa4-7c179e6c90fc"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.838+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.459+09', 'ready', NULL, '2026-10-07 19:12:51.838498+09', '2026-10-07 19:12:51.953133+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('60a9be4a-b274-481d-a7fa-1beef08a824c', 'tenant-a', NULL, 'ab70f9e5-e590-47b6-9ac0-e33600e28294', 'v1', 'tenant-a の記憶 22 東京 会議 プロジェクト2', 'b72c9757075adda4486522b26365dfd82a6af69336a4c8f52d4771450c4ce0af', 'tenant-a の記憶 22 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.841Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ab70f9e5-e590-47b6-9ac0-e33600e28294"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.843+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.464+09', 'ready', NULL, '2026-10-07 19:12:51.844734+09', '2026-10-07 19:12:51.956575+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('464e8b6a-e223-4946-ab92-c30c8c7d6d0c', 'tenant-a', NULL, '1d57fc61-4b98-49cf-a971-5a1a482e94c0', 'v1', 'tenant-a の記憶 23 東京 会議 プロジェクト3', '26d0049fe3cf7614c786a48dd795226413a4f6260e020ea8356d457c6ff1ca3f', 'tenant-a の記憶 23 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.848Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1d57fc61-4b98-49cf-a971-5a1a482e94c0"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.85+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.471+09', 'ready', NULL, '2026-10-07 19:12:51.850518+09', '2026-10-07 19:12:51.965825+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b02b0fa2-fa68-4505-a998-efe8ac11f6d0', 'tenant-a', NULL, '76103319-fe1c-4607-9b92-458e99711a3d', 'v1', 'tenant-a FAIL 埋め込み失敗 東京', 'ab1702dac85d2545c823794fc8106c348a2783463f2ac321911b7721adc9a696', 'tenant-a FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.855Z", "kind": "stated", "speaker": "user", "sourceObservationId": "76103319-fe1c-4607-9b92-458e99711a3d"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.859+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.48+09', 'failed', NULL, '2026-10-07 19:12:51.859893+09', '2026-10-07 19:12:51.969226+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('09e42cf5-58dd-496c-8f0e-ca2db70fea87', 'tenant-a', NULL, '5c69edff-14ab-4126-ae13-d8390e7d783a', 'v1', 'tenant-a 未埋め込み 0', '756d0ee3ef05fe980db2aa5224ed49ab257c9c10a80d33a77df32294e4a9b497', 'tenant-a 未埋め込み 0', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.972Z", "kind": "stated", "speaker": "user", "sourceObservationId": "5c69edff-14ab-4126-ae13-d8390e7d783a"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.974+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.595+09', 'pending', NULL, '2026-10-07 19:12:51.974909+09', '2026-10-07 19:12:51.974909+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8bbf52e0-3f71-4492-a289-0cc9c0d21309', 'tenant-a', NULL, 'd0236ccf-7bb8-4f01-bd84-479b72b55bd0', 'v1', 'tenant-a 未埋め込み 1', '7a1a046d3656ac2ae59f0f95d457c9c60be31eb915f2dd5cdc53822faaefdf48', 'tenant-a 未埋め込み 1', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.978Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d0236ccf-7bb8-4f01-bd84-479b72b55bd0"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.98+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.601+09', 'pending', NULL, '2026-10-07 19:12:51.980855+09', '2026-10-07 19:12:51.980855+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('74bb4b4c-9f10-453b-83a5-7c751a5e6634', 'tenant-a', NULL, '53e2a9ee-6642-403a-a570-c34ec9ec206d', 'v1', 'tenant-a 未埋め込み 2', '899e3558b907c6a4074d675812af26d32f5a4d665344080e52cfed3d3c1218f6', 'tenant-a 未埋め込み 2', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.985Z", "kind": "stated", "speaker": "user", "sourceObservationId": "53e2a9ee-6642-403a-a570-c34ec9ec206d"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.987+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.608+09', 'skipped', NULL, '2026-10-07 19:12:51.987961+09', '2026-10-07 19:12:51.992845+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('3aad2359-9ce5-47d3-8499-3d122b931d75', 'tenant-a', NULL, '715cfe5e-eb70-4e99-865a-91f1a30805d3', 'v1', 'tenant-a の記憶 8 東京 会議 プロジェクト3', 'b80d062281da38b404565ed86841de51799a3a0b5a8332e8ae6c080d35716009', 'tenant-a の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.752Z", "kind": "stated", "speaker": "user", "sourceObservationId": "715cfe5e-eb70-4e99-865a-91f1a30805d3"}', 'contested', NULL, '01767b15-4fd2-438b-86d7-ac0312ea6421', '{}', NULL, '2026-10-07 19:12:51.754+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.375+09', 'ready', NULL, '2026-10-07 19:12:51.755496+09', '2026-10-07 19:12:51.998157+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('400a62ea-1ab6-4d34-88dc-45c27c4bf60e', 'tenant-a', NULL, '0c4c0422-c503-4ffb-9333-9890df324c0d', 'v1', 'tenant-a の記憶 20 東京 会議 プロジェクト0', '30b8312facf5b4d080051518335646cf1b0811d3dd74936bb276b5f511c2fda4', 'tenant-a の記憶 20 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:51.831Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0c4c0422-c503-4ffb-9333-9890df324c0d"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:51.833+09', '2026-10-07 19:12:52.059+09', NULL, NULL, 1, 720, '2027-02-14 11:00:09.68+09', 'ready', NULL, '2026-10-07 19:12:51.833524+09', '2026-10-07 19:12:52.060731+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f7e7c94a-0411-49ec-9dbe-12585c3ddf78', 'tenant-b', NULL, 'cf977ea6-1a38-484c-ba40-0574f09ac458', 'v1', 'tenant-b の記憶 1 東京 会議 プロジェクト1', 'b95da75a3bc21f8d9d823c4d001c8086e008dcc6b38e31d6ed7199e9b758b564', 'tenant-b の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.076Z", "kind": "stated", "speaker": "user", "sourceObservationId": "cf977ea6-1a38-484c-ba40-0574f09ac458"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.078+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.699+09', 'ready', NULL, '2026-10-07 19:12:52.078687+09', '2026-10-07 19:12:52.300187+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('528b2953-538b-46e9-bb90-7d2962241368', 'tenant-b', NULL, '518da3ba-bd83-4808-9312-272e38f54eae', 'v1', 'tenant-b の記憶 2 東京 会議 プロジェクト2', 'fef0437ad217559ad5fb73795ca3cec2b335060d36ad7ba7a9da30c623a8f0d3', 'tenant-b の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.082Z", "kind": "stated", "speaker": "user", "sourceObservationId": "518da3ba-bd83-4808-9312-272e38f54eae"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.084+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.705+09', 'ready', NULL, '2026-10-07 19:12:52.085225+09', '2026-10-07 19:12:52.306685+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('99ef7e87-2791-47f2-aa14-3dda1f2986d3', 'tenant-b', NULL, 'da6f82b5-3b5a-4826-b4a3-f5edbd5e66a7', 'v1', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', '4e273dcb447fab0d9f4acfd5e8288bf45f0c7eb77b08b9cc0534c25d49c0c4f8', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.089Z", "kind": "stated", "speaker": "user", "sourceObservationId": "da6f82b5-3b5a-4826-b4a3-f5edbd5e66a7"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.09+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.711+09', 'ready', NULL, '2026-10-07 19:12:52.091475+09', '2026-10-07 19:12:52.314131+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('3162294f-c08c-40e0-a234-4bcf93cda901', 'tenant-b', NULL, '88220acf-e49d-472e-adc4-9d9f941d4b58', 'v1', 'tenant-b の記憶 5 東京 会議 プロジェクト0', '1d9b410d61390a28c636568bbffd238b4e1012db936d587ca2fb4c25642981e9', 'tenant-b の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.104Z", "kind": "stated", "speaker": "user", "sourceObservationId": "88220acf-e49d-472e-adc4-9d9f941d4b58"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.107+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.728+09', 'ready', NULL, '2026-10-07 19:12:52.108286+09', '2026-10-07 19:12:52.325141+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d5a955fb-8a2d-4724-8ce8-5ea29765ddf4', 'tenant-b', NULL, 'd4a6aac1-81c8-4624-bec5-7e80325c910c', 'v1', 'tenant-b の記憶 7 東京 会議 プロジェクト2', 'f1d4ed789aa4b33b86f74868c1d9f1efbac874dbb3cbbdd89a13eabcd6826704', 'tenant-b の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.119Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d4a6aac1-81c8-4624-bec5-7e80325c910c"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.121+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.742+09', 'ready', NULL, '2026-10-07 19:12:52.12178+09', '2026-10-07 19:12:52.331141+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('3757a0f2-1d20-4ed8-96d6-cea64cf1e1b0', 'tenant-b', NULL, '1c809914-599d-42b7-a59b-28794884fc86', 'v1', 'tenant-b の記憶 12 東京 会議 プロジェクト2', '7b361a170b64a9b41f97d624b8bc1cb0f2c68950bfea639ccb5a23c4344575f8', 'tenant-b の記憶 12 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.241Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1c809914-599d-42b7-a59b-28794884fc86"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.248+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.869+09', 'ready', NULL, '2026-10-07 19:12:52.248934+09', '2026-10-07 19:12:52.350543+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('07758de0-0b13-4eb4-8130-3d24ce222d05', 'tenant-b', NULL, '7f73d7ba-b709-462c-82e7-b4115f1c1cf3', 'v1', 'tenant-b の記憶 13 東京 会議 プロジェクト3', '0dc090582bdaf2135130a122f6f926027aa9346166b076aa7ce9d878071c18f3', 'tenant-b の記憶 13 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.254Z", "kind": "stated", "speaker": "user", "sourceObservationId": "7f73d7ba-b709-462c-82e7-b4115f1c1cf3"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.259+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.88+09', 'ready', NULL, '2026-10-07 19:12:52.260374+09', '2026-10-07 19:12:52.35613+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8a9121da-4b25-476e-bdf0-dda5f7b43ce3', 'tenant-b', NULL, '7f53591d-2d1d-43fb-97e0-ab4b245ffcfc', 'v1', 'tenant-b の記憶 15 東京 会議 プロジェクト0', '159e45fbd8a5ffaff4ae601883d4d60fd353ceca26759a1642630065cef3b241', 'tenant-b の記憶 15 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.269Z", "kind": "stated", "speaker": "user", "sourceObservationId": "7f53591d-2d1d-43fb-97e0-ab4b245ffcfc"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.272+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.893+09', 'ready', NULL, '2026-10-07 19:12:52.272427+09', '2026-10-07 19:12:52.363384+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ace9fecc-db87-4cf4-ba51-15341c4d9170', 'tenant-b', NULL, '921cdeb5-f983-4851-9d07-938825ae041d', 'v1', 'tenant-b の記憶 4 東京 会議 プロジェクト4', '5940641d2d369c2cc336a4e7e0dfe324af8bd43c6c6bb540111ea25536b9f590', 'tenant-b の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.095Z", "kind": "stated", "speaker": "user", "sourceObservationId": "921cdeb5-f983-4851-9d07-938825ae041d"}', 'superseded', '3162294f-c08c-40e0-a234-4bcf93cda901', NULL, '{}', NULL, '2026-10-07 19:12:52.097+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.718+09', 'ready', NULL, '2026-10-07 19:12:52.097736+09', '2026-10-07 19:12:52.392614+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('2345525e-c383-4053-9786-b90220bda018', 'tenant-b', NULL, '68adba13-2b98-4121-a184-c38df6ed88f3', 'v1', 'tenant-b の記憶 6 東京 会議 プロジェクト1', '25dbc01aa826c3caa1c214b61d630f769615fc5a4f74f62be2b71c2a659e3fa8', 'tenant-b の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.113Z", "kind": "stated", "speaker": "user", "sourceObservationId": "68adba13-2b98-4121-a184-c38df6ed88f3"}', 'contested', NULL, '213f102f-6494-46a8-a329-7184d3c1c791', '{}', NULL, '2026-10-07 19:12:52.115+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.736+09', 'ready', NULL, '2026-10-07 19:12:52.116004+09', '2026-10-07 19:12:52.393931+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('7633e5f4-f718-4997-8dd0-ef5df5925b28', 'tenant-b', NULL, 'bbb13b2e-a281-4d91-ad42-567edcc1ccdb', 'v1', 'tenant-b の記憶 9 東京 会議 プロジェクト4', '1e67543f28e3ecb46017a56947f528295cfd849f37bbff911216c8f13f03cb45', 'tenant-b の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.146Z", "kind": "stated", "speaker": "user", "sourceObservationId": "bbb13b2e-a281-4d91-ad42-567edcc1ccdb"}', 'archived', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.152+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.773+09', 'ready', NULL, '2026-10-07 19:12:52.152826+09', '2026-10-07 19:12:52.397175+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('bd770266-dd60-4236-9770-60f3ab636c27', 'tenant-b', NULL, 'cdad6ecd-9af2-4ca8-90cb-7d0afdb96ac5', 'v1', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', 'e3ce75d1b42cf68db24819b6cf5a26b4168b236f492bda9ec4f44f99baf6e59f', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.158Z", "kind": "stated", "speaker": "user", "sourceObservationId": "cdad6ecd-9af2-4ca8-90cb-7d0afdb96ac5"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.165+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.786+09', 'ready', NULL, '2026-10-07 19:12:52.166377+09', '2026-10-07 19:12:52.398347+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('74ad85f3-2bed-4993-b600-dfa269edb9af', 'tenant-b', NULL, '3c1f1000-a08f-414b-aff7-6c59e3cf742e', 'v1', '[purged]', '624794e8e55d99b8d71021f048790ff041d1bfb438372d59bcdfa91e5e3b0bcd', '[purged]', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.182Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3c1f1000-a08f-414b-aff7-6c59e3cf742e"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.193+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.814+09', 'ready', '2026-10-07 19:12:52.401+09', '2026-10-07 19:12:52.194051+09', '2026-10-07 19:12:52.401441+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('54c374fa-f7b3-4db5-9a5c-4c8de3385bc7', 'tenant-b', NULL, 'f3be50bf-a5b0-4e37-9411-98d9217d6afe', 'v1', 'tenant-b の記憶 14 東京 会議 プロジェクト4', '8a607cfc5964eaf69142f32afe35b75600e27d38176864ada321967ce349bc64', 'tenant-b の記憶 14 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.263Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f3be50bf-a5b0-4e37-9411-98d9217d6afe"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.265+09', '2026-10-07 19:12:52.427+09', NULL, NULL, 1, 720, '2027-02-14 11:00:10.048+09', 'ready', NULL, '2026-10-07 19:12:52.265605+09', '2026-10-07 19:12:52.428152+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c10b7458-aef5-4886-a8e4-f339ab991e81', 'tenant-b', NULL, '89fe1cd5-2602-426b-be31-2e401867a9b4', 'v1', 'tenant-b の記憶 0 東京 会議 プロジェクト0', '081a9a9f113b084d0ccebeb4e29f753910bca11b2e4e20168eca50413e85a174', 'tenant-b の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.069Z", "kind": "stated", "speaker": "user", "sourceObservationId": "89fe1cd5-2602-426b-be31-2e401867a9b4"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.072+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.693+09', 'ready', NULL, '2026-10-07 19:12:52.072505+09', '2026-10-07 19:12:52.296663+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d917c811-ee4e-47ba-b95e-eeb1af32515f', 'tenant-b', NULL, '262d14e7-ebe4-4e2c-a3db-e5092b88a7d2', 'v1', 'tenant-b の記憶 16 東京 会議 プロジェクト1', 'b8c54c018860dad1bd5d84c2883f7deef7dba67a41562560b7454f3565547826', 'tenant-b の記憶 16 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.279Z", "kind": "stated", "speaker": "user", "sourceObservationId": "262d14e7-ebe4-4e2c-a3db-e5092b88a7d2"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.28+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.901+09', 'ready', NULL, '2026-10-07 19:12:52.280984+09', '2026-10-07 19:12:52.366662+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('58cc3a78-bdc4-4f49-80b0-c4b5bf0446ab', 'tenant-b', NULL, '5c28395e-b509-497d-a1cc-a5ab81358b8c', 'v1', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', '512794d1b4203897a59658ba1c10d0d4ff10f5d69627a6dffa186e0a86c02feb', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.284Z", "kind": "stated", "speaker": "user", "sourceObservationId": "5c28395e-b509-497d-a1cc-a5ab81358b8c"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.285+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.906+09', 'ready', NULL, '2026-10-07 19:12:52.28609+09', '2026-10-07 19:12:52.369698+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('76c5a046-8a29-4efa-8313-0798f4f706ae', 'tenant-b', NULL, '0dd65950-e6dd-4476-b175-5a34913016e8', 'v1', 'tenant-b FAIL 埋め込み失敗 東京', 'dca6507a3912ad169580cf2764c29ddf080a9cbf73c32d7ddf16429d985d35ef', 'tenant-b FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.288Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0dd65950-e6dd-4476-b175-5a34913016e8"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.29+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.911+09', 'failed', NULL, '2026-10-07 19:12:52.290488+09', '2026-10-07 19:12:52.373264+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1dc03000-9b4f-465d-86da-c76b90217646', 'tenant-b', NULL, 'defd1013-2d3a-42b2-a7e9-3959482ef8a8', 'v1', 'tenant-b 未埋め込み 0', '4f033a8ab5dff18cce4bfac1ffa04151f80b45e51806b9cebeca92a143ae6386', 'tenant-b 未埋め込み 0', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.374Z", "kind": "stated", "speaker": "user", "sourceObservationId": "defd1013-2d3a-42b2-a7e9-3959482ef8a8"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.377+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.998+09', 'pending', NULL, '2026-10-07 19:12:52.377412+09', '2026-10-07 19:12:52.377412+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('4ab8047e-cd2d-4c71-8c8d-1cfe2e0acd2a', 'tenant-b', NULL, '3ecf20ea-0a31-48a0-b9cd-a08cad357338', 'v1', 'tenant-b 未埋め込み 1', '9d77f4b53475fe24e31aaa3bcdc02aa1a0786c37888dcee783f146c4aae191e2', 'tenant-b 未埋め込み 1', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.380Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3ecf20ea-0a31-48a0-b9cd-a08cad357338"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.382+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.003+09', 'pending', NULL, '2026-10-07 19:12:52.38238+09', '2026-10-07 19:12:52.38238+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('4c8e161d-6af2-442c-8c6f-35239c511284', 'tenant-b', NULL, '0a5eb70c-2d21-4fbe-bbf1-def22ef7e7e9', 'v1', 'tenant-b 未埋め込み 2', '318fb30d6dda58f1c972e4779c59979fbd926637878da937d6155ac62a286d02', 'tenant-b 未埋め込み 2', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.385Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0a5eb70c-2d21-4fbe-bbf1-def22ef7e7e9"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.387+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.008+09', 'skipped', NULL, '2026-10-07 19:12:52.387902+09', '2026-10-07 19:12:52.391422+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('213f102f-6494-46a8-a329-7184d3c1c791', 'tenant-b', NULL, 'e8fdff78-8168-4035-a428-282710724370', 'v1', 'tenant-b の記憶 8 東京 会議 プロジェクト3', '03f24fe74d5d2e3d56878e412d3b0daf983f57c46d18f1bf25917b76cf7ef9f6', 'tenant-b の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.125Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e8fdff78-8168-4035-a428-282710724370"}', 'forgotten', NULL, '2345525e-c383-4053-9786-b90220bda018', '{}', NULL, '2026-10-07 19:12:52.127+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:09.748+09', 'ready', NULL, '2026-10-07 19:12:52.12817+09', '2026-10-07 19:12:52.411216+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d53aa6f1-efc2-4133-84e8-c23c261072db', 'tenant-c', NULL, '51546901-6ab4-4ecf-8005-b753e6809f06', 'v1', 'tenant-c の記憶 1 東京 会議 プロジェクト1', 'f97a8b4d6e8a9c4b9cc08f892895a26c5150d4dc14b0da37a299e97b759312b2', 'tenant-c の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.438Z", "kind": "stated", "speaker": "user", "sourceObservationId": "51546901-6ab4-4ecf-8005-b753e6809f06"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.442+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.063+09', 'ready', NULL, '2026-10-07 19:12:52.442616+09', '2026-10-07 19:12:52.519897+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('440644be-1a40-4a24-9e3a-999c8178bf4c', 'tenant-c', NULL, '27545251-2d0b-4651-ba1f-99eed32fcfef', 'v1', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', '94612eb1b4f64fa932a1d3db6feb48231cb950d9ffd00939776db4cf1eb29c26', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.454Z", "kind": "stated", "speaker": "user", "sourceObservationId": "27545251-2d0b-4651-ba1f-99eed32fcfef"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.455+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.076+09', 'ready', NULL, '2026-10-07 19:12:52.455898+09', '2026-10-07 19:12:52.530088+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f3821780-bee5-497a-b4be-a989bd6cbaf2', 'tenant-c', NULL, '9ee72daa-0842-42d1-8d29-900b2aaa4afa', 'v1', 'tenant-c の記憶 7 東京 会議 プロジェクト2', '8c524a04f68127aef3b7b341e63ac27629ee3136f0ef9da63934e27c206cb419', 'tenant-c の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.474Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9ee72daa-0842-42d1-8d29-900b2aaa4afa"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.476+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.097+09', 'ready', NULL, '2026-10-07 19:12:52.476558+09', '2026-10-07 19:12:52.551103+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('89f0242f-7729-43bd-a2b3-b81acc754c6f', 'tenant-c', NULL, 'a651cc1e-69cd-4680-9a6d-192705e29bf4', 'v1', 'tenant-c の記憶 4 東京 会議 プロジェクト4', '81f4ee70cb39ef24184d9447f8e119462e2b333831286169f12207dd00f50327', 'tenant-c の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.458Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a651cc1e-69cd-4680-9a6d-192705e29bf4"}', 'superseded', '3319bcd3-1742-44e9-bb42-ea02638343b0', NULL, '{}', NULL, '2026-10-07 19:12:52.459+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.08+09', 'ready', NULL, '2026-10-07 19:12:52.460078+09', '2026-10-07 19:12:52.590643+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e6054322-3049-4f0b-8cb0-0c0f1172aa02', 'tenant-c', NULL, 'a5c0ab37-a6d5-4cdc-9509-cd89723b9d89', 'v1', 'tenant-c の記憶 6 東京 会議 プロジェクト1', '1349732c0ebd9031ddc9bcae41973c5c6b6ab2f76e2179b5374ad6957af1fe87', 'tenant-c の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.468Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a5c0ab37-a6d5-4cdc-9509-cd89723b9d89"}', 'contested', NULL, '4b29392a-ff03-4202-acf2-ecc848c47351', '{}', NULL, '2026-10-07 19:12:52.47+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.091+09', 'ready', NULL, '2026-10-07 19:12:52.471321+09', '2026-10-07 19:12:52.593434+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('3319bcd3-1742-44e9-bb42-ea02638343b0', 'tenant-c', NULL, '1fcb8bd2-c114-477a-a370-58bfb6b97123', 'v1', 'tenant-c の記憶 5 東京 会議 プロジェクト0', '0996fea87104119898e02a0d9962c82a2dfe8c52e32205dc818277bcf516daf6', 'tenant-c の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.463Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1fcb8bd2-c114-477a-a370-58bfb6b97123"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.464+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.085+09', 'ready', NULL, '2026-10-07 19:12:52.465468+09', '2026-10-07 19:12:52.61696+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('43fba119-9a63-4595-bbea-66238cfe4009', 'tenant-c', NULL, 'a213d506-819b-407d-a9ef-141bf80c965c', 'v1', 'tenant-c の記憶 2 東京 会議 プロジェクト2', '2576291adf7ad31335c6494eb95a197053599c859b1067bc5f6b08c63fbd8fc2', 'tenant-c の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.447Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a213d506-819b-407d-a9ef-141bf80c965c"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.45+09', '2026-10-07 19:12:52.639+09', NULL, NULL, 1, 720, '2027-02-14 11:00:10.26+09', 'ready', NULL, '2026-10-07 19:12:52.450574+09', '2026-10-07 19:12:52.639894+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('acf6281f-843b-4c01-be93-d6f4a2a1be04', 'tenant-c', NULL, 'b7e2918c-1d17-4ee6-8997-ffbbfd77f539', 'v1', 'tenant-c の記憶 0 東京 会議 プロジェクト0', '0d78da8c6a4e2de262064e70959180f45578ab348746afc04814736d3ec98420', 'tenant-c の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.432Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b7e2918c-1d17-4ee6-8997-ffbbfd77f539"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.434+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.055+09', 'ready', NULL, '2026-10-07 19:12:52.434481+09', '2026-10-07 19:12:52.516437+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a2a3e4af-738a-4558-b1a2-d698be696c1e', 'tenant-c', NULL, '846d54b0-52f3-4824-ac42-55d6bcd610a2', 'v1', 'tenant-c FAIL 埋め込み失敗 東京', '985f97e69b2fc62b500ebd50803bce5a72393d80852f55d01d88a21002fd7746', 'tenant-c FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.508Z", "kind": "stated", "speaker": "user", "sourceObservationId": "846d54b0-52f3-4824-ac42-55d6bcd610a2"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.509+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.13+09', 'failed', NULL, '2026-10-07 19:12:52.510129+09', '2026-10-07 19:12:52.567062+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a50807a2-1ed9-4501-96e5-791784019580', 'tenant-c', NULL, '1f78d7a5-2198-4466-94b5-585c307a7e04', 'v1', 'tenant-c 未埋め込み 0', 'dbbed7a9da3bc87703ee74ec7fcbae128292a28245a094e1e7fe55b2e761766d', 'tenant-c 未埋め込み 0', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.569Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1f78d7a5-2198-4466-94b5-585c307a7e04"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.571+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.192+09', 'pending', NULL, '2026-10-07 19:12:52.572402+09', '2026-10-07 19:12:52.572402+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c3e02248-0c52-4df5-bd10-9966495a7261', 'tenant-c', NULL, '845b6702-0924-4210-8f55-316cc5de1f13', 'v1', 'tenant-c 未埋め込み 1', '6fef40b085316dc1f9517118e7701e59fddc1231ce2b4b7b03aaf45936697d74', 'tenant-c 未埋め込み 1', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.577Z", "kind": "stated", "speaker": "user", "sourceObservationId": "845b6702-0924-4210-8f55-316cc5de1f13"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.578+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.199+09', 'pending', NULL, '2026-10-07 19:12:52.579274+09', '2026-10-07 19:12:52.579274+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('12496de4-aa92-4616-81e9-f8eab2f262f2', 'tenant-c', NULL, 'c6f74baa-6572-455d-ae7c-10be1cbeb8a2', 'v1', 'tenant-c 未埋め込み 2', 'd4169a93c46303e6cc20af167d50c6ffb9c86896911949620cd36e561554b6c1', 'tenant-c 未埋め込み 2', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.583Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c6f74baa-6572-455d-ae7c-10be1cbeb8a2"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.585+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.206+09', 'skipped', NULL, '2026-10-07 19:12:52.585474+09', '2026-10-07 19:12:52.589199+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('4b29392a-ff03-4202-acf2-ecc848c47351', 'tenant-c', NULL, '86b6d267-2ea3-4c07-9eeb-383030097f3d', 'v1', 'tenant-c の記憶 8 東京 会議 プロジェクト3', '27955d03f0fb4db217579a1e5dbf74beed76d3f569305b1ab21cd24db6b92e36', 'tenant-c の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.481Z", "kind": "stated", "speaker": "user", "sourceObservationId": "86b6d267-2ea3-4c07-9eeb-383030097f3d"}', 'contested', NULL, 'e6054322-3049-4f0b-8cb0-0c0f1172aa02', '{}', NULL, '2026-10-07 19:12:52.483+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.104+09', 'ready', NULL, '2026-10-07 19:12:52.483489+09', '2026-10-07 19:12:52.593434+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('16840f6c-70d7-4bcf-9177-47fa25a07288', 'tenant-c', NULL, '656e297a-4352-420a-a704-0129ee2a0d2a', 'v1', 'tenant-c の記憶 9 東京 会議 プロジェクト4', 'd8961ae07e5a93b6b0dc84ea6ee4aa46d7a585e6dfcbda5aaddc38a2ce3974b6', 'tenant-c の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.486Z", "kind": "stated", "speaker": "user", "sourceObservationId": "656e297a-4352-420a-a704-0129ee2a0d2a"}', 'archived', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.489+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.11+09', 'ready', NULL, '2026-10-07 19:12:52.490128+09', '2026-10-07 19:12:52.597536+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('19c872f6-8d04-4472-ba15-67cd823bf126', 'tenant-c', NULL, 'ea7ec8b5-b118-46e3-b0bf-07088df6b91d', 'v1', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', 'be6295fd3fa665a4400e99e456e7ac4a6311b950abd5ab167494cf5cf1661dc4', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.495Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ea7ec8b5-b118-46e3-b0bf-07088df6b91d"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.497+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.118+09', 'ready', NULL, '2026-10-07 19:12:52.497755+09', '2026-10-07 19:12:52.601085+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('16b8bf3e-0449-491c-bc31-68cf473dd039', 'tenant-c', NULL, 'c1a01894-1ab7-4795-871e-b79b14f94dce', 'v1', '[purged]', '90508b50cef379d5c03fa9f0c876b432c0e3fe77e30b0a0ccc82349c9d4a406f', '[purged]', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.501Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c1a01894-1ab7-4795-871e-b79b14f94dce"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.502+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.123+09', 'ready', '2026-10-07 19:12:52.608+09', '2026-10-07 19:12:52.503464+09', '2026-10-07 19:12:52.609005+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b7700129-cc17-42c1-a253-0d880251b449', 'tenant-a2', NULL, 'fb4be86a-992d-4c6e-9d6d-9e925bd6f5e2', 'v1', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', 'a785d27623732af65fc0f05c80ea5e8638cd85eb944016167297bd92393c0331', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.665Z", "kind": "stated", "speaker": "user", "sourceObservationId": "fb4be86a-992d-4c6e-9d6d-9e925bd6f5e2"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.668+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.289+09', 'ready', NULL, '2026-10-07 19:12:52.668843+09', '2026-10-07 19:12:52.733092+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('4cf3b6a3-60dd-4c10-b99e-05a49df3085b', 'tenant-a2', NULL, '6f3ebc30-c6cd-426b-a880-73d77d098e3f', 'v1', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', '2ff9054147bebbf3ab7b87786763739a75177d4a5b1f441bea040bf1eca421f4', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.678Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6f3ebc30-c6cd-426b-a880-73d77d098e3f"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.68+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.301+09', 'ready', NULL, '2026-10-07 19:12:52.680956+09', '2026-10-07 19:12:52.743794+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c9a89bc9-4f95-4a16-bab3-0ac9b2ce3a6a', 'tenant-a2', NULL, 'a0ec89f0-437b-4f8b-a6a3-d33c994d9188', 'v1', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', '914fb28b9e9744124fe125428a1d2ccdd0770428843fc02994496676178c35ee', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.689Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a0ec89f0-437b-4f8b-a6a3-d33c994d9188"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.691+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.312+09', 'ready', NULL, '2026-10-07 19:12:52.692076+09', '2026-10-07 19:12:52.751513+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('508d83d2-b520-4776-803d-b9a1c7096ae7', 'tenant-a2', NULL, '2100c358-6b7f-48bf-9f35-993271b9f5bf', 'v1', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', '24ab90528718614c3e988124ed86cb1748700763560be7ef27c8bf4b5dcfd1ab', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.672Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2100c358-6b7f-48bf-9f35-993271b9f5bf"}', 'superseded', '4cf3b6a3-60dd-4c10-b99e-05a49df3085b', NULL, '{}', NULL, '2026-10-07 19:12:52.674+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.295+09', 'ready', NULL, '2026-10-07 19:12:52.674926+09', '2026-10-07 19:12:52.789228+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f8f00d0e-6f75-4543-97da-10cb06d60fa3', 'tenant-a2', NULL, '70c5dcc4-2b10-4fd1-bb01-d0c2e2a4e509', 'v1', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', '7592207a458219fa91a20d15fb9715e0462c1b13647e460421449a8734cc3f3b', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.684Z", "kind": "stated", "speaker": "user", "sourceObservationId": "70c5dcc4-2b10-4fd1-bb01-d0c2e2a4e509"}', 'contested', NULL, 'bfcdc3db-c2d6-4bda-b13f-0e3d66efc308', '{}', NULL, '2026-10-07 19:12:52.686+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.307+09', 'ready', NULL, '2026-10-07 19:12:52.686434+09', '2026-10-07 19:12:52.790887+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c3565db1-1d89-4840-92a4-72202a1d7d1b', 'tenant-a2', NULL, 'd2af2469-a243-41da-8ce3-95a21b50e1db', 'v1', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', '4cf1d599eeca369fd9803aad38e37386c99caf014b2df0588842e802cb851f62', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.657Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d2af2469-a243-41da-8ce3-95a21b50e1db"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.66+09', '2026-10-07 19:12:52.82+09', NULL, NULL, 1, 720, '2027-02-14 11:00:10.441+09', 'ready', NULL, '2026-10-07 19:12:52.660503+09', '2026-10-07 19:12:52.821484+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('00f84f24-e729-4fbe-bd5d-4e50ae927069', 'tenant-a2', NULL, '2d51a829-15a5-48f3-a788-08388c8107be', 'v1', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', 'cc6965c4ce873014f25affb39c4d6773bd8fb57667bfa6de70490b30eeb8b9c2', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.644Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2d51a829-15a5-48f3-a788-08388c8107be"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.647+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.268+09', 'ready', NULL, '2026-10-07 19:12:52.647738+09', '2026-10-07 19:12:52.719092+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6e16eb94-cbcd-428d-a869-b165aa923156', 'tenant-a2', NULL, '1a0649c2-d851-452a-9045-37f8d86d0e03', 'v1', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', '98db05eaf2b468995ca8ddfb04238b6a3f78950faff175f1bfb6be45a8249e43', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.651Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1a0649c2-d851-452a-9045-37f8d86d0e03"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.653+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.274+09', 'ready', NULL, '2026-10-07 19:12:52.654191+09', '2026-10-07 19:12:52.722309+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('afb827c4-1fdd-4108-a182-2064b7042e38', 'tenant-a2', NULL, '5938f6cb-a78d-4810-a547-db58a810d2e2', 'v1', 'tenant-a2 FAIL 埋め込み失敗 東京', '72456a5d7a68e3f7d1e7d082bd8429d137478336dc0b7ab44c25aae0508cf9c7', 'tenant-a2 FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.711Z", "kind": "stated", "speaker": "user", "sourceObservationId": "5938f6cb-a78d-4810-a547-db58a810d2e2"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.712+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.333+09', 'failed', NULL, '2026-10-07 19:12:52.713355+09', '2026-10-07 19:12:52.767289+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('006af83c-df70-4a57-a587-ba1e246ecd6d', 'tenant-a2', NULL, '64d6558e-677f-4f5a-b6b9-3376bfcaf3d4', 'v1', 'tenant-a2 未埋め込み 2', '361bf58e0bbb5d4804764e21fd48bddde845290c4fcd3281b746852036325696', 'tenant-a2 未埋め込み 2', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.783Z", "kind": "stated", "speaker": "user", "sourceObservationId": "64d6558e-677f-4f5a-b6b9-3376bfcaf3d4"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.784+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.405+09', 'skipped', NULL, '2026-10-07 19:12:52.785078+09', '2026-10-07 19:12:52.788045+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('bfcdc3db-c2d6-4bda-b13f-0e3d66efc308', 'tenant-a2', NULL, '5aeaf542-a623-411e-ab60-9d8d3eec836d', 'v1', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', '97de39f5fe1e8a6b2164b4726c2ae28bd112a4222632a171a6a79d866131fa79', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.696Z", "kind": "stated", "speaker": "user", "sourceObservationId": "5aeaf542-a623-411e-ab60-9d8d3eec836d"}', 'contested', NULL, 'f8f00d0e-6f75-4543-97da-10cb06d60fa3', '{}', NULL, '2026-10-07 19:12:52.698+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.319+09', 'ready', NULL, '2026-10-07 19:12:52.699223+09', '2026-10-07 19:12:52.790887+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('54ed5ae5-101a-44f5-bb90-82d65a7d5c4a', 'tenant-a2', NULL, 'e25c1728-d32d-434e-8f9f-da0740f96989', 'v1', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', 'f43da00aa2d66eb30de895210fc22e5cba0548b91eb41edc808208389480c46c', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.703Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e25c1728-d32d-434e-8f9f-da0740f96989"}', 'archived', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.706+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.327+09', 'ready', NULL, '2026-10-07 19:12:52.706617+09', '2026-10-07 19:12:52.794197+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8de058cd-3b91-4ba2-8124-eb6eba86559f', 'tenant-a2', NULL, '6758aa96-3ea1-4016-b661-4c897dd55bb4', 'v1', 'tenant-a2 未埋め込み 0', '096af51a3f55ac6f12d4f7ae6b8dadd71299c722c9f56ac9764db3bd05d536e4', 'tenant-a2 未埋め込み 0', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.769Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6758aa96-3ea1-4016-b661-4c897dd55bb4"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.772+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.393+09', 'pending', NULL, '2026-10-07 19:12:52.772563+09', '2026-10-07 19:12:52.796116+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('5bff9eb5-314a-4147-8d00-5cfefe9c39f4', 'tenant-a2', NULL, '6b0f0d6d-3559-4834-a174-43d30fce1e9c', 'v1', '[purged]', 'e78005a62ce1fe1dc602590187cd521751267c830e60191f8b6622dafb10a298', '[purged]', 'llm', 'stated', '{"at": "2026-10-07T10:12:52.777Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6b0f0d6d-3559-4834-a174-43d30fce1e9c"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:52.779+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:10.4+09', 'pending', '2026-10-07 19:12:52.8+09', '2026-10-07 19:12:52.780265+09', '2026-10-07 19:12:52.800157+09', NULL, NULL, NULL, '{}', NULL, NULL);


--
-- Data for Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'acf6281f-843b-4c01-be93-d6f4a2a1be04', '[16,772,45,207]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:52.51533+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'd53aa6f1-efc2-4133-84e8-c23c261072db', '[16,773,45,208]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:52.518995+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '43fba119-9a63-4595-bbea-66238cfe4009', '[16,774,45,209]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:52.523134+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '440644be-1a40-4a24-9e3a-999c8178bf4c', '[0,0,0,0]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:52.528068+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '89f0242f-7729-43bd-a2b3-b81acc754c6f', '[16,776,45,211]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:52.534976+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '3319bcd3-1742-44e9-bb42-ea02638343b0', '[16,777,45,207]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:52.541393+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'e6054322-3049-4f0b-8cb0-0c0f1172aa02', '[16,778,45,208]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:52.546034+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'f3821780-bee5-497a-b4be-a989bd6cbaf2', '[16,779,45,209]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:52.550246+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '4b29392a-ff03-4202-acf2-ecc848c47351', '[16,780,45,210]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:52.553188+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '16840f6c-70d7-4bcf-9177-47fa25a07288', '[16,781,45,211]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:52.556135+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '19c872f6-8d04-4472-ba15-67cd823bf126', '[0,0,0,0]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:52.55899+09');


--
-- Data for Name: memory_embeddings_test_fixture_model_3; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '2fbb63f9-0722-4677-bab2-8d3b7533f9f8', '[677,880,478]', 'fixture-model', '2026-10-07 19:12:51.868244+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '7758338c-58cb-4fc7-8bbe-1392d468e32c', '[678,881,478]', 'fixture-model', '2026-10-07 19:12:51.872774+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '9e5e0ceb-69d0-4469-9673-6d333ffe6575', '[679,882,478]', 'fixture-model', '2026-10-07 19:12:51.876173+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'b0ebb353-77af-487e-bc5e-644be85d3c7a', '[0,0,0]', 'fixture-model', '2026-10-07 19:12:51.879304+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'a5a0aa63-a181-43dd-966b-c2d7b2e8b773', '[681,884,478]', 'fixture-model', '2026-10-07 19:12:51.882523+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '58ec7654-8f38-4c2e-adb6-309bccf32956', '[677,885,478]', 'fixture-model', '2026-10-07 19:12:51.886097+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '01767b15-4fd2-438b-86d7-ac0312ea6421', '[678,886,478]', 'fixture-model', '2026-10-07 19:12:51.890019+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'fcd8b5e4-3c5e-41ea-bbaa-0817d76d824c', '[679,887,478]', 'fixture-model', '2026-10-07 19:12:51.893799+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '3aad2359-9ce5-47d3-8499-3d122b931d75', '[680,888,478]', 'fixture-model', '2026-10-07 19:12:51.897159+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'aeb13a03-10a2-42c9-8a8f-31bd47e15b05', '[681,889,478]', 'fixture-model', '2026-10-07 19:12:51.901643+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '6ce3006a-5038-44f3-95b0-37cce6eb5b81', '[0,0,0]', 'fixture-model', '2026-10-07 19:12:51.906685+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'c8a9eeb5-ed23-4c73-9df3-a30482aa550f', '[855,769,464]', 'fixture-model', '2026-10-07 19:12:51.920659+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '1f155584-eb38-4b19-a539-45252c8b2d02', '[855,770,465]', 'fixture-model', '2026-10-07 19:12:51.924096+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '66a39a9a-cee2-4d2a-83d1-e74a795f2069', '[855,771,466]', 'fixture-model', '2026-10-07 19:12:51.927395+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'ae8e9716-84e9-47f3-a501-596a9b524ff5', '[855,767,467]', 'fixture-model', '2026-10-07 19:12:51.930686+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'a877a726-3af7-4c82-9e2e-074cd07ab8cb', '[855,768,468]', 'fixture-model', '2026-10-07 19:12:51.934107+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'b7adc42b-6c36-489a-abd9-318425688272', '[0,0,0]', 'fixture-model', '2026-10-07 19:12:51.93718+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'f164a835-0ac4-48e1-a09d-4e2b161b1ce1', '[855,770,470]', 'fixture-model', '2026-10-07 19:12:51.940067+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'a800507b-204e-4829-9160-ebd0e307c892', '[855,771,471]', 'fixture-model', '2026-10-07 19:12:51.942829+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '400a62ea-1ab6-4d34-88dc-45c27c4bf60e', '[855,768,462]', 'fixture-model', '2026-10-07 19:12:51.948885+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '09d4c803-84ed-45fb-8cd9-2342917e0943', '[855,769,463]', 'fixture-model', '2026-10-07 19:12:51.952367+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '60a9be4a-b274-481d-a7fa-1beef08a824c', '[855,770,464]', 'fixture-model', '2026-10-07 19:12:51.955813+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '464e8b6a-e223-4946-ab92-c30c8c7d6d0c', '[855,771,465]', 'fixture-model', '2026-10-07 19:12:51.964523+09');


--
-- Data for Name: memory_embeddings_testkit_deterministic_8; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'c10b7458-aef5-4886-a8e4-f339ab991e81', '[839,69,404,38,174,703,638,168]', 'deterministic', '2026-10-07 19:12:52.295409+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'f7e7c94a-0411-49ec-9dbe-12585c3ddf78', '[839,69,404,39,174,704,638,168]', 'deterministic', '2026-10-07 19:12:52.299465+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '528b2953-538b-46e9-bb90-7d2962241368', '[839,69,404,40,174,705,638,168]', 'deterministic', '2026-10-07 19:12:52.303266+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '99ef7e87-2791-47f2-aa14-3dda1f2986d3', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-10-07 19:12:52.312229+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'ace9fecc-db87-4cf4-ba51-15341c4d9170', '[839,69,404,42,174,707,638,168]', 'deterministic', '2026-10-07 19:12:52.319942+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '3162294f-c08c-40e0-a234-4bcf93cda901', '[839,69,404,38,174,708,638,168]', 'deterministic', '2026-10-07 19:12:52.324438+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '2345525e-c383-4053-9786-b90220bda018', '[839,69,404,39,174,709,638,168]', 'deterministic', '2026-10-07 19:12:52.3276+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'd5a955fb-8a2d-4724-8ce8-5ea29765ddf4', '[839,69,404,40,174,710,638,168]', 'deterministic', '2026-10-07 19:12:52.330486+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '213f102f-6494-46a8-a329-7184d3c1c791', '[839,69,404,41,174,711,638,168]', 'deterministic', '2026-10-07 19:12:52.333271+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '7633e5f4-f718-4997-8dd0-ef5df5925b28', '[839,69,404,42,174,712,638,168]', 'deterministic', '2026-10-07 19:12:52.336144+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'bd770266-dd60-4236-9770-60f3ab636c27', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-10-07 19:12:52.3408+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '3757a0f2-1d20-4ed8-96d6-cea64cf1e1b0', '[218,229,101,23,993,197,634,691]', 'deterministic', '2026-10-07 19:12:52.34985+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '07758de0-0b13-4eb4-8130-3d24ce222d05', '[218,229,101,23,994,197,635,691]', 'deterministic', '2026-10-07 19:12:52.355219+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '54c374fa-f7b3-4db5-9a5c-4c8de3385bc7', '[218,229,101,23,995,197,636,691]', 'deterministic', '2026-10-07 19:12:52.358853+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '8a9121da-4b25-476e-bdf0-dda5f7b43ce3', '[218,229,101,23,991,197,637,691]', 'deterministic', '2026-10-07 19:12:52.362642+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'd917c811-ee4e-47ba-b95e-eeb1af32515f', '[218,229,101,23,992,197,638,691]', 'deterministic', '2026-10-07 19:12:52.365901+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '58cc3a78-bdc4-4f49-80b0-c4b5bf0446ab', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-10-07 19:12:52.369031+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '00f84f24-e729-4fbe-bd5d-4e50ae927069', '[236,824,78,391,51,180,632,690]', 'deterministic', '2026-10-07 19:12:52.718437+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '6e16eb94-cbcd-428d-a869-b165aa923156', '[236,824,78,391,52,180,633,690]', 'deterministic', '2026-10-07 19:12:52.721501+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'c3565db1-1d89-4840-92a4-72202a1d7d1b', '[236,824,78,391,53,180,634,690]', 'deterministic', '2026-10-07 19:12:52.724669+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'b7700129-cc17-42c1-a253-0d880251b449', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-10-07 19:12:52.732134+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '508d83d2-b520-4776-803d-b9a1c7096ae7', '[236,824,78,391,55,180,636,690]', 'deterministic', '2026-10-07 19:12:52.738004+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '4cf3b6a3-60dd-4c10-b99e-05a49df3085b', '[236,824,78,391,51,180,637,690]', 'deterministic', '2026-10-07 19:12:52.742893+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'f8f00d0e-6f75-4543-97da-10cb06d60fa3', '[236,824,78,391,52,180,638,690]', 'deterministic', '2026-10-07 19:12:52.747481+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'c9a89bc9-4f95-4a16-bab3-0ac9b2ce3a6a', '[236,824,78,391,53,180,639,690]', 'deterministic', '2026-10-07 19:12:52.750632+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'bfcdc3db-c2d6-4bda-b13f-0e3d66efc308', '[236,824,78,391,54,180,640,690]', 'deterministic', '2026-10-07 19:12:52.754662+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '54ed5ae5-101a-44f5-bb90-82d65a7d5c4a', '[236,824,78,391,55,180,641,690]', 'deterministic', '2026-10-07 19:12:52.759028+09');


--
-- Data for Name: memory_events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_events VALUES ('bd62c44a-46fa-4bd4-97e8-70e62ab18d73', 'tenant-a', '2fbb63f9-0722-4677-bab2-8d3b7533f9f8', 'created', '2026-10-07 19:12:51.696+09', '{"type": "system"}', 'tenant-a の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9d1710c8-c82d-4418-a3b2-b4939e87f704"}');
INSERT INTO public.memory_events VALUES ('6cc0ce63-34b6-415e-9a3d-36e1376f8d0d', 'tenant-a', '7758338c-58cb-4fc7-8bbe-1392d468e32c', 'created', '2026-10-07 19:12:51.706+09', '{"type": "system"}', 'tenant-a の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "daae69af-69c0-45ff-99b8-4972d5ce6e45"}');
INSERT INTO public.memory_events VALUES ('0f78566c-e156-44e2-b178-9e700ab36533', 'tenant-a', '9e5e0ceb-69d0-4469-9673-6d333ffe6575', 'created', '2026-10-07 19:12:51.711+09', '{"type": "system"}', 'tenant-a の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1d2d9caf-692c-4577-90d9-2db4913c712a"}');
INSERT INTO public.memory_events VALUES ('c4ce60ce-027e-4d15-ad0a-ea48afd811a7', 'tenant-a', 'b0ebb353-77af-487e-bc5e-644be85d3c7a', 'created', '2026-10-07 19:12:51.717+09', '{"type": "system"}', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b52ba63f-4a71-4e7b-af72-234d39a0095b"}');
INSERT INTO public.memory_events VALUES ('8e814b92-3a14-4f72-8f36-f79fef5d1b97', 'tenant-a', 'a5a0aa63-a181-43dd-966b-c2d7b2e8b773', 'created', '2026-10-07 19:12:51.722+09', '{"type": "system"}', 'tenant-a の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0ec8b0b8-af1a-4b9e-b53f-aa73944085b1"}');
INSERT INTO public.memory_events VALUES ('db68892b-efc1-4b1f-add7-c61983866512', 'tenant-a', '58ec7654-8f38-4c2e-adb6-309bccf32956', 'created', '2026-10-07 19:12:51.734+09', '{"type": "system"}', 'tenant-a の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "97d65c31-acfc-4a7b-8627-60eefe64e758"}');
INSERT INTO public.memory_events VALUES ('a0a3f14d-69ed-4518-ac85-1b7ab81de527', 'tenant-a', '01767b15-4fd2-438b-86d7-ac0312ea6421', 'created', '2026-10-07 19:12:51.741+09', '{"type": "system"}', 'tenant-a の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8e4b04ea-597a-44f0-8f27-0d7bbfdc3f78"}');
INSERT INTO public.memory_events VALUES ('e9932f36-3d36-4d9e-a303-49ea9ff10fb5', 'tenant-a', 'fcd8b5e4-3c5e-41ea-bbaa-0817d76d824c', 'created', '2026-10-07 19:12:51.75+09', '{"type": "system"}', 'tenant-a の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "29fcb6f2-0517-425f-b85e-caa82d1814a3"}');
INSERT INTO public.memory_events VALUES ('ff3dba22-dd19-47c4-92fd-804a85fee774', 'tenant-a', '3aad2359-9ce5-47d3-8499-3d122b931d75', 'created', '2026-10-07 19:12:51.758+09', '{"type": "system"}', 'tenant-a の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "715cfe5e-eb70-4e99-865a-91f1a30805d3"}');
INSERT INTO public.memory_events VALUES ('f4f4fd6c-ba04-44d6-b57f-85d7cd932b8d', 'tenant-a', 'aeb13a03-10a2-42c9-8a8f-31bd47e15b05', 'created', '2026-10-07 19:12:51.763+09', '{"type": "system"}', 'tenant-a の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "90008bba-3ae4-4f0a-bfc4-69037c3e0a1f"}');
INSERT INTO public.memory_events VALUES ('4ddfffbb-9a29-43e2-8b83-190aee4d20ba', 'tenant-a', '6ce3006a-5038-44f3-95b0-37cce6eb5b81', 'created', '2026-10-07 19:12:51.773+09', '{"type": "system"}', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d47f19f5-8844-4f8c-b833-26651e293018"}');
INSERT INTO public.memory_events VALUES ('cfc49b9f-6abd-406e-bef9-8ac98aded7ec', 'tenant-a', '28d469b7-5c04-42f8-b519-b9d6fd6fd888', 'created', '2026-10-07 19:12:51.78+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2a28d662-ebf6-4f86-b4fd-567127d47e80"}');
INSERT INTO public.memory_events VALUES ('2c4d8be9-ead2-4d21-9b39-99132080e642', 'tenant-a', 'c8a9eeb5-ed23-4c73-9df3-a30482aa550f', 'created', '2026-10-07 19:12:51.786+09', '{"type": "system"}', 'tenant-a の記憶 12 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ecfa5245-ce1d-407c-824d-c1a1164961cf"}');
INSERT INTO public.memory_events VALUES ('0a4d074b-c329-44cf-adef-b8fb50dcba75', 'tenant-a', '1f155584-eb38-4b19-a539-45252c8b2d02', 'created', '2026-10-07 19:12:51.793+09', '{"type": "system"}', 'tenant-a の記憶 13 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "bda1a8c6-709a-4900-b090-7ccd8b64e030"}');
INSERT INTO public.memory_events VALUES ('85889d77-1b69-4794-8ca5-d8caa7fa834d', 'tenant-a', '66a39a9a-cee2-4d2a-83d1-e74a795f2069', 'created', '2026-10-07 19:12:51.801+09', '{"type": "system"}', 'tenant-a の記憶 14 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "03427a62-292e-45ba-9967-f214dadd233c"}');
INSERT INTO public.memory_events VALUES ('96df5f98-55e7-4add-bd81-770d2a188b2f', 'tenant-a', 'ae8e9716-84e9-47f3-a501-596a9b524ff5', 'created', '2026-10-07 19:12:51.808+09', '{"type": "system"}', 'tenant-a の記憶 15 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e516bf03-b0d5-4104-9048-17b22e32b58e"}');
INSERT INTO public.memory_events VALUES ('a0e22f9d-7561-4635-bb8d-a1b53e12ebea', 'tenant-a', 'a877a726-3af7-4c82-9e2e-074cd07ab8cb', 'created', '2026-10-07 19:12:51.814+09', '{"type": "system"}', 'tenant-a の記憶 16 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a66c556d-2f87-47f0-ad6d-53ae2a7cba68"}');
INSERT INTO public.memory_events VALUES ('a3b854da-d0b6-46d2-b55c-ed23d1ed2c0b', 'tenant-a', 'b7adc42b-6c36-489a-abd9-318425688272', 'created', '2026-10-07 19:12:51.819+09', '{"type": "system"}', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1c16d7b9-77db-4492-a4c2-b0a87c3bb3c2"}');
INSERT INTO public.memory_events VALUES ('98f4c4f0-3348-44b7-ba3e-77d2fb44422f', 'tenant-a', 'f164a835-0ac4-48e1-a09d-4e2b161b1ce1', 'created', '2026-10-07 19:12:51.825+09', '{"type": "system"}', 'tenant-a の記憶 18 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "7807148b-fd04-4d27-b84f-1030e74e1a55"}');
INSERT INTO public.memory_events VALUES ('693d82c6-43dc-49bc-ad4c-58f8c7079598', 'tenant-a', 'a800507b-204e-4829-9160-ebd0e307c892', 'created', '2026-10-07 19:12:51.83+09', '{"type": "system"}', 'tenant-a の記憶 19 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ae8fee43-0288-436f-9286-f00ad62bc188"}');
INSERT INTO public.memory_events VALUES ('4f56fe4b-02ba-4c34-aacb-cad92f327a4e', 'tenant-a', '400a62ea-1ab6-4d34-88dc-45c27c4bf60e', 'created', '2026-10-07 19:12:51.835+09', '{"type": "system"}', 'tenant-a の記憶 20 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0c4c0422-c503-4ffb-9333-9890df324c0d"}');
INSERT INTO public.memory_events VALUES ('a143e69c-9d8d-4cab-a472-acff80af465e', 'tenant-a', '09d4c803-84ed-45fb-8cd9-2342917e0943', 'created', '2026-10-07 19:12:51.84+09', '{"type": "system"}', 'tenant-a の記憶 21 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a5b6653b-8006-4503-bfa4-7c179e6c90fc"}');
INSERT INTO public.memory_events VALUES ('c58a7411-857f-446f-b04e-c16ba3f24825', 'tenant-a', '60a9be4a-b274-481d-a7fa-1beef08a824c', 'created', '2026-10-07 19:12:51.846+09', '{"type": "system"}', 'tenant-a の記憶 22 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ab70f9e5-e590-47b6-9ac0-e33600e28294"}');
INSERT INTO public.memory_events VALUES ('f78ead3b-e9b5-45f5-89f3-1adb3bec1822', 'tenant-a', '464e8b6a-e223-4946-ab92-c30c8c7d6d0c', 'created', '2026-10-07 19:12:51.853+09', '{"type": "system"}', 'tenant-a の記憶 23 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1d57fc61-4b98-49cf-a971-5a1a482e94c0"}');
INSERT INTO public.memory_events VALUES ('524c659a-ba85-4686-95c2-ee8936d10960', 'tenant-a', 'b02b0fa2-fa68-4505-a998-efe8ac11f6d0', 'created', '2026-10-07 19:12:51.862+09', '{"type": "system"}', 'tenant-a FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "76103319-fe1c-4607-9b92-458e99711a3d"}');
INSERT INTO public.memory_events VALUES ('5dc9752c-fd44-48b8-b0d1-721596afe2ba', 'tenant-a', '09e42cf5-58dd-496c-8f0e-ca2db70fea87', 'created', '2026-10-07 19:12:51.977+09', '{"type": "system"}', 'tenant-a 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "5c69edff-14ab-4126-ae13-d8390e7d783a"}');
INSERT INTO public.memory_events VALUES ('731d3d81-5556-4234-8512-afe3f34510e4', 'tenant-a', '8bbf52e0-3f71-4492-a289-0cc9c0d21309', 'created', '2026-10-07 19:12:51.983+09', '{"type": "system"}', 'tenant-a 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d0236ccf-7bb8-4f01-bd84-479b72b55bd0"}');
INSERT INTO public.memory_events VALUES ('b2c3ee0b-c134-440a-bea3-3ac204901eb3', 'tenant-a', '74bb4b4c-9f10-453b-83a5-7c751a5e6634', 'created', '2026-10-07 19:12:51.99+09', '{"type": "system"}', 'tenant-a 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "53e2a9ee-6642-403a-a570-c34ec9ec206d"}');
INSERT INTO public.memory_events VALUES ('d8411c52-1752-4dcc-ada9-4213a016ed49', 'tenant-a', '01767b15-4fd2-438b-86d7-ac0312ea6421', 'updated', '2026-10-07 19:12:51.997+09', '{"type": "system"}', 'tenant-a の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "3aad2359-9ce5-47d3-8499-3d122b931d75"}');
INSERT INTO public.memory_events VALUES ('a9cfa40e-e5b2-4277-98d9-857674a69a84', 'tenant-a', '3aad2359-9ce5-47d3-8499-3d122b931d75', 'updated', '2026-10-07 19:12:51.997+09', '{"type": "system"}', 'tenant-a の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "01767b15-4fd2-438b-86d7-ac0312ea6421"}');
INSERT INTO public.memory_events VALUES ('51a40308-0061-4f66-8121-4677de1f5e7b', 'tenant-a', '6ce3006a-5038-44f3-95b0-37cce6eb5b81', 'forgotten', '2026-10-07 19:12:52.005+09', '{"type": "system"}', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('eb5cdcf5-3b17-4709-a893-6e89f4043fa9', 'tenant-a', '28d469b7-5c04-42f8-b519-b9d6fd6fd888', 'forgotten', '2026-10-07 19:12:52.008+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('ed7918dd-d2a0-41a9-9e15-6573b77dc2d4', 'tenant-a', '28d469b7-5c04-42f8-b519-b9d6fd6fd888', 'purged', '2026-10-07 19:12:52.011+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('17ffb2d5-1718-4bbb-bdb6-2ebc485dbe82', 'tenant-b', 'c10b7458-aef5-4886-a8e4-f339ab991e81', 'created', '2026-10-07 19:12:52.075+09', '{"type": "system"}', 'tenant-b の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "89fe1cd5-2602-426b-be31-2e401867a9b4"}');
INSERT INTO public.memory_events VALUES ('c3743a2b-20a1-4f98-bb13-4963711d5ee8', 'tenant-b', 'f7e7c94a-0411-49ec-9dbe-12585c3ddf78', 'created', '2026-10-07 19:12:52.08+09', '{"type": "system"}', 'tenant-b の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "cf977ea6-1a38-484c-ba40-0574f09ac458"}');
INSERT INTO public.memory_events VALUES ('3c5a821e-7a59-4427-b93c-0ff31b261266', 'tenant-b', '528b2953-538b-46e9-bb90-7d2962241368', 'created', '2026-10-07 19:12:52.087+09', '{"type": "system"}', 'tenant-b の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "518da3ba-bd83-4808-9312-272e38f54eae"}');
INSERT INTO public.memory_events VALUES ('4e26485e-e76c-449c-88ef-d9929812f121', 'tenant-b', '99ef7e87-2791-47f2-aa14-3dda1f2986d3', 'created', '2026-10-07 19:12:52.093+09', '{"type": "system"}', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "da6f82b5-3b5a-4826-b4a3-f5edbd5e66a7"}');
INSERT INTO public.memory_events VALUES ('4e7f5c48-9f9f-4c6e-9129-35c9478e8b41', 'tenant-b', 'ace9fecc-db87-4cf4-ba51-15341c4d9170', 'created', '2026-10-07 19:12:52.101+09', '{"type": "system"}', 'tenant-b の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "921cdeb5-f983-4851-9d07-938825ae041d"}');
INSERT INTO public.memory_events VALUES ('4a21a65f-890d-4893-9c08-c5753e3dae4b', 'tenant-b', '3162294f-c08c-40e0-a234-4bcf93cda901', 'created', '2026-10-07 19:12:52.111+09', '{"type": "system"}', 'tenant-b の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "88220acf-e49d-472e-adc4-9d9f941d4b58"}');
INSERT INTO public.memory_events VALUES ('73d63d57-2c1f-49da-8963-68ef8b940591', 'tenant-b', '2345525e-c383-4053-9786-b90220bda018', 'created', '2026-10-07 19:12:52.118+09', '{"type": "system"}', 'tenant-b の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "68adba13-2b98-4121-a184-c38df6ed88f3"}');
INSERT INTO public.memory_events VALUES ('9a7da209-2d08-4985-b536-a78259802f8e', 'tenant-b', 'd5a955fb-8a2d-4724-8ce8-5ea29765ddf4', 'created', '2026-10-07 19:12:52.123+09', '{"type": "system"}', 'tenant-b の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d4a6aac1-81c8-4624-bec5-7e80325c910c"}');
INSERT INTO public.memory_events VALUES ('a9338467-d492-4901-a7b0-0751774e9d60', 'tenant-b', '213f102f-6494-46a8-a329-7184d3c1c791', 'created', '2026-10-07 19:12:52.129+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e8fdff78-8168-4035-a428-282710724370"}');
INSERT INTO public.memory_events VALUES ('46191b63-4e3b-4ec1-a46c-1119765e1485', 'tenant-b', '7633e5f4-f718-4997-8dd0-ef5df5925b28', 'created', '2026-10-07 19:12:52.156+09', '{"type": "system"}', 'tenant-b の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "bbb13b2e-a281-4d91-ad42-567edcc1ccdb"}');
INSERT INTO public.memory_events VALUES ('395e5ad3-7e6e-449e-8719-b28cecfcf1e9', 'tenant-b', 'bd770266-dd60-4236-9770-60f3ab636c27', 'created', '2026-10-07 19:12:52.169+09', '{"type": "system"}', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "cdad6ecd-9af2-4ca8-90cb-7d0afdb96ac5"}');
INSERT INTO public.memory_events VALUES ('11f117b3-a03a-4724-ae62-12c18061a2f7', 'tenant-b', '74ad85f3-2bed-4993-b600-dfa269edb9af', 'created', '2026-10-07 19:12:52.196+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3c1f1000-a08f-414b-aff7-6c59e3cf742e"}');
INSERT INTO public.memory_events VALUES ('ed9e0081-3a16-43cc-bfb9-c76930f0db98', 'tenant-b', '3757a0f2-1d20-4ed8-96d6-cea64cf1e1b0', 'created', '2026-10-07 19:12:52.251+09', '{"type": "system"}', 'tenant-b の記憶 12 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1c809914-599d-42b7-a59b-28794884fc86"}');
INSERT INTO public.memory_events VALUES ('c3ded3e9-0d85-413d-9888-51451e73abfa', 'tenant-b', '07758de0-0b13-4eb4-8130-3d24ce222d05', 'created', '2026-10-07 19:12:52.262+09', '{"type": "system"}', 'tenant-b の記憶 13 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "7f73d7ba-b709-462c-82e7-b4115f1c1cf3"}');
INSERT INTO public.memory_events VALUES ('9247fdad-7f95-49d6-8b03-25e54af959fe', 'tenant-b', '54c374fa-f7b3-4db5-9a5c-4c8de3385bc7', 'created', '2026-10-07 19:12:52.267+09', '{"type": "system"}', 'tenant-b の記憶 14 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f3be50bf-a5b0-4e37-9411-98d9217d6afe"}');
INSERT INTO public.memory_events VALUES ('fb555b27-a2ef-4599-9578-3937eb03aaa2', 'tenant-b', '8a9121da-4b25-476e-bdf0-dda5f7b43ce3', 'created', '2026-10-07 19:12:52.273+09', '{"type": "system"}', 'tenant-b の記憶 15 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "7f53591d-2d1d-43fb-97e0-ab4b245ffcfc"}');
INSERT INTO public.memory_events VALUES ('b9c04414-8d0e-4054-8a0f-0bf851823c8c', 'tenant-b', 'd917c811-ee4e-47ba-b95e-eeb1af32515f', 'created', '2026-10-07 19:12:52.283+09', '{"type": "system"}', 'tenant-b の記憶 16 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "262d14e7-ebe4-4e2c-a3db-e5092b88a7d2"}');
INSERT INTO public.memory_events VALUES ('b6e61212-c27f-4a4f-bc0e-5564f0a5102b', 'tenant-b', '58cc3a78-bdc4-4f49-80b0-c4b5bf0446ab', 'created', '2026-10-07 19:12:52.287+09', '{"type": "system"}', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "5c28395e-b509-497d-a1cc-a5ab81358b8c"}');
INSERT INTO public.memory_events VALUES ('44b5baf3-fe8c-4a9c-9829-fa669320ec00', 'tenant-b', '76c5a046-8a29-4efa-8313-0798f4f706ae', 'created', '2026-10-07 19:12:52.292+09', '{"type": "system"}', 'tenant-b FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0dd65950-e6dd-4476-b175-5a34913016e8"}');
INSERT INTO public.memory_events VALUES ('2ee3ba34-1a20-4e13-9211-3169c33cb8ff', 'tenant-b', '1dc03000-9b4f-465d-86da-c76b90217646', 'created', '2026-10-07 19:12:52.379+09', '{"type": "system"}', 'tenant-b 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "defd1013-2d3a-42b2-a7e9-3959482ef8a8"}');
INSERT INTO public.memory_events VALUES ('db33f74f-cd68-4ba8-a44b-c3a1478850d0', 'tenant-b', '4ab8047e-cd2d-4c71-8c8d-1cfe2e0acd2a', 'created', '2026-10-07 19:12:52.384+09', '{"type": "system"}', 'tenant-b 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3ecf20ea-0a31-48a0-b9cd-a08cad357338"}');
INSERT INTO public.memory_events VALUES ('9ece3018-d242-46ee-b779-a291ed49a7f1', 'tenant-b', '4c8e161d-6af2-442c-8c6f-35239c511284', 'created', '2026-10-07 19:12:52.389+09', '{"type": "system"}', 'tenant-b 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0a5eb70c-2d21-4fbe-bbf1-def22ef7e7e9"}');
INSERT INTO public.memory_events VALUES ('1fba705a-2882-48c3-9139-e0091e4f389e', 'tenant-b', '2345525e-c383-4053-9786-b90220bda018', 'updated', '2026-10-07 19:12:52.393+09', '{"type": "system"}', 'tenant-b の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "213f102f-6494-46a8-a329-7184d3c1c791"}');
INSERT INTO public.memory_events VALUES ('eba94fcb-6838-4342-a7b2-46cec5fd206a', 'tenant-b', '213f102f-6494-46a8-a329-7184d3c1c791', 'updated', '2026-10-07 19:12:52.393+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "2345525e-c383-4053-9786-b90220bda018"}');
INSERT INTO public.memory_events VALUES ('bb81af16-9b28-4a86-a2e6-bb86714c10da', 'tenant-b', 'bd770266-dd60-4236-9770-60f3ab636c27', 'forgotten', '2026-10-07 19:12:52.398+09', '{"type": "system"}', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('f494d6e1-90db-436a-946b-d0b79abfb291', 'tenant-b', '74ad85f3-2bed-4993-b600-dfa269edb9af', 'forgotten', '2026-10-07 19:12:52.399+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('54abc24f-5a2f-4ee1-a6e8-97417cdcf13b', 'tenant-b', '74ad85f3-2bed-4993-b600-dfa269edb9af', 'purged', '2026-10-07 19:12:52.401+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('81884674-516d-4ea5-b0c8-442e259881d9', 'tenant-b', '213f102f-6494-46a8-a329-7184d3c1c791', 'forgotten', '2026-10-07 19:12:52.41+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "fixture: orphaned contested"}');
INSERT INTO public.memory_events VALUES ('46ba613b-1b61-4264-bdbc-2257cfa4418e', 'tenant-c', 'acf6281f-843b-4c01-be93-d6f4a2a1be04', 'created', '2026-10-07 19:12:52.436+09', '{"type": "system"}', 'tenant-c の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b7e2918c-1d17-4ee6-8997-ffbbfd77f539"}');
INSERT INTO public.memory_events VALUES ('0cdc3ee6-3721-43b7-b60d-6c86cf56aa67', 'tenant-c', 'd53aa6f1-efc2-4133-84e8-c23c261072db', 'created', '2026-10-07 19:12:52.446+09', '{"type": "system"}', 'tenant-c の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "51546901-6ab4-4ecf-8005-b753e6809f06"}');
INSERT INTO public.memory_events VALUES ('e0680962-139f-45a3-9ea6-a2ea202d0f89', 'tenant-c', '43fba119-9a63-4595-bbea-66238cfe4009', 'created', '2026-10-07 19:12:52.452+09', '{"type": "system"}', 'tenant-c の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a213d506-819b-407d-a9ef-141bf80c965c"}');
INSERT INTO public.memory_events VALUES ('89e1f38d-1043-42b7-b567-40be27842d52', 'tenant-c', '440644be-1a40-4a24-9e3a-999c8178bf4c', 'created', '2026-10-07 19:12:52.457+09', '{"type": "system"}', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "27545251-2d0b-4651-ba1f-99eed32fcfef"}');
INSERT INTO public.memory_events VALUES ('34564a69-3c1c-42e9-8114-169f9ad8c1d6', 'tenant-c', '89f0242f-7729-43bd-a2b3-b81acc754c6f', 'created', '2026-10-07 19:12:52.461+09', '{"type": "system"}', 'tenant-c の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a651cc1e-69cd-4680-9a6d-192705e29bf4"}');
INSERT INTO public.memory_events VALUES ('b7fe8831-10d1-456a-b763-8ba944566eb6', 'tenant-c', '3319bcd3-1742-44e9-bb42-ea02638343b0', 'created', '2026-10-07 19:12:52.467+09', '{"type": "system"}', 'tenant-c の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1fcb8bd2-c114-477a-a370-58bfb6b97123"}');
INSERT INTO public.memory_events VALUES ('d3cab57e-f696-4415-b4d2-b1d127e50cbd', 'tenant-c', 'e6054322-3049-4f0b-8cb0-0c0f1172aa02', 'created', '2026-10-07 19:12:52.473+09', '{"type": "system"}', 'tenant-c の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a5c0ab37-a6d5-4cdc-9509-cd89723b9d89"}');
INSERT INTO public.memory_events VALUES ('d6089c5c-4209-4143-b63c-be404696b958', 'tenant-c', 'f3821780-bee5-497a-b4be-a989bd6cbaf2', 'created', '2026-10-07 19:12:52.479+09', '{"type": "system"}', 'tenant-c の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9ee72daa-0842-42d1-8d29-900b2aaa4afa"}');
INSERT INTO public.memory_events VALUES ('1418c0e6-afbd-4096-8f34-65bf67be924b', 'tenant-c', '4b29392a-ff03-4202-acf2-ecc848c47351', 'created', '2026-10-07 19:12:52.485+09', '{"type": "system"}', 'tenant-c の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "86b6d267-2ea3-4c07-9eeb-383030097f3d"}');
INSERT INTO public.memory_events VALUES ('a45d2917-d91a-4a8f-bc01-9148d6ee0241', 'tenant-c', '16840f6c-70d7-4bcf-9177-47fa25a07288', 'created', '2026-10-07 19:12:52.493+09', '{"type": "system"}', 'tenant-c の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "656e297a-4352-420a-a704-0129ee2a0d2a"}');
INSERT INTO public.memory_events VALUES ('4b7a2306-3d49-4c0d-a71c-08962b17baf9', 'tenant-c', '19c872f6-8d04-4472-ba15-67cd823bf126', 'created', '2026-10-07 19:12:52.499+09', '{"type": "system"}', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ea7ec8b5-b118-46e3-b0bf-07088df6b91d"}');
INSERT INTO public.memory_events VALUES ('6e581716-2b4f-4bb0-9b59-751ecc0e46f5', 'tenant-c', '16b8bf3e-0449-491c-bc31-68cf473dd039', 'created', '2026-10-07 19:12:52.506+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c1a01894-1ab7-4795-871e-b79b14f94dce"}');
INSERT INTO public.memory_events VALUES ('a82d3099-a1a6-4dec-82e1-0276becefafa', 'tenant-c', 'a2a3e4af-738a-4558-b1a2-d698be696c1e', 'created', '2026-10-07 19:12:52.511+09', '{"type": "system"}', 'tenant-c FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "846d54b0-52f3-4824-ac42-55d6bcd610a2"}');
INSERT INTO public.memory_events VALUES ('c461f24c-41da-4941-b00f-4dd7a9acb9dd', 'tenant-c', 'a50807a2-1ed9-4501-96e5-791784019580', 'created', '2026-10-07 19:12:52.574+09', '{"type": "system"}', 'tenant-c 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1f78d7a5-2198-4466-94b5-585c307a7e04"}');
INSERT INTO public.memory_events VALUES ('d454b9c1-7f33-4e92-b44c-fb4b8e0a4fd7', 'tenant-c', 'c3e02248-0c52-4df5-bd10-9966495a7261', 'created', '2026-10-07 19:12:52.581+09', '{"type": "system"}', 'tenant-c 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "845b6702-0924-4210-8f55-316cc5de1f13"}');
INSERT INTO public.memory_events VALUES ('bc0588f9-4878-4a49-90d3-92f27f1d307e', 'tenant-c', '12496de4-aa92-4616-81e9-f8eab2f262f2', 'created', '2026-10-07 19:12:52.587+09', '{"type": "system"}', 'tenant-c 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c6f74baa-6572-455d-ae7c-10be1cbeb8a2"}');
INSERT INTO public.memory_events VALUES ('68135a35-1533-48cc-90ee-60a001243391', 'tenant-c', 'e6054322-3049-4f0b-8cb0-0c0f1172aa02', 'updated', '2026-10-07 19:12:52.593+09', '{"type": "system"}', 'tenant-c の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "4b29392a-ff03-4202-acf2-ecc848c47351"}');
INSERT INTO public.memory_events VALUES ('c16ce91d-3124-4e4a-8432-7c63b7b28963', 'tenant-c', '4b29392a-ff03-4202-acf2-ecc848c47351', 'updated', '2026-10-07 19:12:52.593+09', '{"type": "system"}', 'tenant-c の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "e6054322-3049-4f0b-8cb0-0c0f1172aa02"}');
INSERT INTO public.memory_events VALUES ('3c1d04f4-4707-4bed-82e7-f58264d3fbee', 'tenant-c', '19c872f6-8d04-4472-ba15-67cd823bf126', 'forgotten', '2026-10-07 19:12:52.6+09', '{"type": "system"}', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('0a039a2a-fd98-4221-a527-a6eb574235b4', 'tenant-c', '16b8bf3e-0449-491c-bc31-68cf473dd039', 'forgotten', '2026-10-07 19:12:52.603+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('9365026a-9c3c-4835-8b5b-1c42dbff2604', 'tenant-c', '16b8bf3e-0449-491c-bc31-68cf473dd039', 'purged', '2026-10-07 19:12:52.608+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('6f178bd4-295a-483e-83fd-5b6ea85f890c', 'tenant-c', '3319bcd3-1742-44e9-bb42-ea02638343b0', 'forgotten', '2026-10-07 19:12:52.616+09', '{"type": "system"}', 'tenant-c の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "fixture: successor forgotten"}');
INSERT INTO public.memory_events VALUES ('f0a961e0-fbaa-49bd-96ae-f0d188e047b7', 'tenant-a2', '00f84f24-e729-4fbe-bd5d-4e50ae927069', 'created', '2026-10-07 19:12:52.649+09', '{"type": "system"}', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2d51a829-15a5-48f3-a788-08388c8107be"}');
INSERT INTO public.memory_events VALUES ('ec6a4bc8-7c0d-4a93-99c6-4bd7770bb187', 'tenant-a2', '6e16eb94-cbcd-428d-a869-b165aa923156', 'created', '2026-10-07 19:12:52.656+09', '{"type": "system"}', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1a0649c2-d851-452a-9045-37f8d86d0e03"}');
INSERT INTO public.memory_events VALUES ('5d4ac9b0-10fb-40bf-814e-dfccae2567fb', 'tenant-a2', 'c3565db1-1d89-4840-92a4-72202a1d7d1b', 'created', '2026-10-07 19:12:52.662+09', '{"type": "system"}', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d2af2469-a243-41da-8ce3-95a21b50e1db"}');
INSERT INTO public.memory_events VALUES ('a18f71aa-f370-4193-a9fb-6106a1b0d0f9', 'tenant-a2', 'b7700129-cc17-42c1-a253-0d880251b449', 'created', '2026-10-07 19:12:52.67+09', '{"type": "system"}', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "fb4be86a-992d-4c6e-9d6d-9e925bd6f5e2"}');
INSERT INTO public.memory_events VALUES ('5b863355-8411-4c57-9cae-aaae26fa7c83', 'tenant-a2', '508d83d2-b520-4776-803d-b9a1c7096ae7', 'created', '2026-10-07 19:12:52.676+09', '{"type": "system"}', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2100c358-6b7f-48bf-9f35-993271b9f5bf"}');
INSERT INTO public.memory_events VALUES ('513ace2f-12ac-405f-8594-d69fba6c3477', 'tenant-a2', '4cf3b6a3-60dd-4c10-b99e-05a49df3085b', 'created', '2026-10-07 19:12:52.682+09', '{"type": "system"}', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6f3ebc30-c6cd-426b-a880-73d77d098e3f"}');
INSERT INTO public.memory_events VALUES ('2460c566-a720-4a18-9d9a-5a96a2fd074d', 'tenant-a2', 'f8f00d0e-6f75-4543-97da-10cb06d60fa3', 'created', '2026-10-07 19:12:52.688+09', '{"type": "system"}', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "70c5dcc4-2b10-4fd1-bb01-d0c2e2a4e509"}');
INSERT INTO public.memory_events VALUES ('f72c86d6-3879-4abf-91a8-57308a54b1e6', 'tenant-a2', 'c9a89bc9-4f95-4a16-bab3-0ac9b2ce3a6a', 'created', '2026-10-07 19:12:52.694+09', '{"type": "system"}', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a0ec89f0-437b-4f8b-a6a3-d33c994d9188"}');
INSERT INTO public.memory_events VALUES ('a83be918-1173-4bce-a09a-b6752e51221f', 'tenant-a2', 'bfcdc3db-c2d6-4bda-b13f-0e3d66efc308', 'created', '2026-10-07 19:12:52.701+09', '{"type": "system"}', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "5aeaf542-a623-411e-ab60-9d8d3eec836d"}');
INSERT INTO public.memory_events VALUES ('c02d19d0-72d4-434a-b851-41cd4aca2f5f', 'tenant-a2', '54ed5ae5-101a-44f5-bb90-82d65a7d5c4a', 'created', '2026-10-07 19:12:52.709+09', '{"type": "system"}', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e25c1728-d32d-434e-8f9f-da0740f96989"}');
INSERT INTO public.memory_events VALUES ('a41d89b2-c9b2-41e7-9258-5b92e0d02817', 'tenant-a2', 'afb827c4-1fdd-4108-a182-2064b7042e38', 'created', '2026-10-07 19:12:52.715+09', '{"type": "system"}', 'tenant-a2 FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "5938f6cb-a78d-4810-a547-db58a810d2e2"}');
INSERT INTO public.memory_events VALUES ('8a39c057-b176-4459-a0c6-5b5a789ee798', 'tenant-a2', '8de058cd-3b91-4ba2-8124-eb6eba86559f', 'created', '2026-10-07 19:12:52.774+09', '{"type": "system"}', 'tenant-a2 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6758aa96-3ea1-4016-b661-4c897dd55bb4"}');
INSERT INTO public.memory_events VALUES ('0967040c-beed-4b4f-afcc-20aca1f676ab', 'tenant-a2', '5bff9eb5-314a-4147-8d00-5cfefe9c39f4', 'created', '2026-10-07 19:12:52.781+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6b0f0d6d-3559-4834-a174-43d30fce1e9c"}');
INSERT INTO public.memory_events VALUES ('0c68adc5-67ea-4648-8745-116a4380ab09', 'tenant-a2', '006af83c-df70-4a57-a587-ba1e246ecd6d', 'created', '2026-10-07 19:12:52.786+09', '{"type": "system"}', 'tenant-a2 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "64d6558e-677f-4f5a-b6b9-3376bfcaf3d4"}');
INSERT INTO public.memory_events VALUES ('40c6a17d-bf55-49af-ad8a-506381fc8df0', 'tenant-a2', 'f8f00d0e-6f75-4543-97da-10cb06d60fa3', 'updated', '2026-10-07 19:12:52.79+09', '{"type": "system"}', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "bfcdc3db-c2d6-4bda-b13f-0e3d66efc308"}');
INSERT INTO public.memory_events VALUES ('5600202d-df9d-428b-a093-b28485af096d', 'tenant-a2', 'bfcdc3db-c2d6-4bda-b13f-0e3d66efc308', 'updated', '2026-10-07 19:12:52.79+09', '{"type": "system"}', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "f8f00d0e-6f75-4543-97da-10cb06d60fa3"}');
INSERT INTO public.memory_events VALUES ('bbe965ef-93bd-4cdf-8982-97b94749feef', 'tenant-a2', '8de058cd-3b91-4ba2-8124-eb6eba86559f', 'forgotten', '2026-10-07 19:12:52.795+09', '{"type": "system"}', 'tenant-a2 未埋め込み 0', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('b0e4686f-be58-402e-a39d-97f449995da9', 'tenant-a2', '5bff9eb5-314a-4147-8d00-5cfefe9c39f4', 'forgotten', '2026-10-07 19:12:52.797+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('044bfa50-c649-4464-867c-ad2668467e0e', 'tenant-a2', '5bff9eb5-314a-4147-8d00-5cfefe9c39f4', 'purged', '2026-10-07 19:12:52.8+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "fixture"}');


--
-- Data for Name: memory_labels; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: memory_relations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: observations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.observations VALUES ('9d1710c8-c82d-4418-a3b2-b4939e87f704', 'tenant-a', NULL, 'tenant-a-ext-0', 'utterance', '{"text": "tenant-a の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:51.678+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('daae69af-69c0-45ff-99b8-4972d5ce6e45', 'tenant-a', NULL, 'tenant-a-ext-1', 'utterance', '{"text": "tenant-a の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:51.7+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1d2d9caf-692c-4577-90d9-2db4913c712a', 'tenant-a', NULL, 'tenant-a-ext-2', 'utterance', '{"text": "tenant-a の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:51.708+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b52ba63f-4a71-4e7b-af72-234d39a0095b', 'tenant-a', NULL, 'tenant-a-ext-3', 'utterance', '{"text": "tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:51.713+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0ec8b0b8-af1a-4b9e-b53f-aa73944085b1', 'tenant-a', NULL, 'tenant-a-ext-4', 'utterance', '{"text": "tenant-a の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:51.719+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('97d65c31-acfc-4a7b-8627-60eefe64e758', 'tenant-a', NULL, 'tenant-a-ext-5', 'utterance', '{"text": "tenant-a の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:51.724+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8e4b04ea-597a-44f0-8f27-0d7bbfdc3f78', 'tenant-a', NULL, 'tenant-a-ext-6', 'utterance', '{"text": "tenant-a の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:51.735+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('29fcb6f2-0517-425f-b85e-caa82d1814a3', 'tenant-a', NULL, 'tenant-a-ext-7', 'utterance', '{"text": "tenant-a の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:51.746+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('715cfe5e-eb70-4e99-865a-91f1a30805d3', 'tenant-a', NULL, 'tenant-a-ext-8', 'utterance', '{"text": "tenant-a の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:51.752+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('90008bba-3ae4-4f0a-bfc4-69037c3e0a1f', 'tenant-a', NULL, 'tenant-a-ext-9', 'utterance', '{"text": "tenant-a の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:51.759+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d47f19f5-8844-4f8c-b833-26651e293018', 'tenant-a', NULL, 'tenant-a-ext-10', 'utterance', '{"text": "tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:51.765+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('2a28d662-ebf6-4f86-b4fd-567127d47e80', 'tenant-a', NULL, 'tenant-a-ext-11', 'utterance', '{"text": "tenant-a の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:51.775+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ecfa5245-ce1d-407c-824d-c1a1164961cf', 'tenant-a', NULL, 'tenant-a-ext-12', 'utterance', '{"text": "tenant-a の記憶 12 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:51.781+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('bda1a8c6-709a-4900-b090-7ccd8b64e030', 'tenant-a', NULL, 'tenant-a-ext-13', 'utterance', '{"text": "tenant-a の記憶 13 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:51.788+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('03427a62-292e-45ba-9967-f214dadd233c', 'tenant-a', NULL, 'tenant-a-ext-14', 'utterance', '{"text": "tenant-a の記憶 14 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:51.795+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e516bf03-b0d5-4104-9048-17b22e32b58e', 'tenant-a', NULL, 'tenant-a-ext-15', 'utterance', '{"text": "tenant-a の記憶 15 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:51.803+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a66c556d-2f87-47f0-ad6d-53ae2a7cba68', 'tenant-a', NULL, 'tenant-a-ext-16', 'utterance', '{"text": "tenant-a の記憶 16 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:51.81+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1c16d7b9-77db-4492-a4c2-b0a87c3bb3c2', 'tenant-a', NULL, 'tenant-a-ext-17', 'utterance', '{"text": "tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:51.816+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('7807148b-fd04-4d27-b84f-1030e74e1a55', 'tenant-a', NULL, 'tenant-a-ext-18', 'utterance', '{"text": "tenant-a の記憶 18 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:51.821+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ae8fee43-0288-436f-9286-f00ad62bc188', 'tenant-a', NULL, 'tenant-a-ext-19', 'utterance', '{"text": "tenant-a の記憶 19 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:51.826+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0c4c0422-c503-4ffb-9333-9890df324c0d', 'tenant-a', NULL, 'tenant-a-ext-20', 'utterance', '{"text": "tenant-a の記憶 20 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:51.831+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a5b6653b-8006-4503-bfa4-7c179e6c90fc', 'tenant-a', NULL, 'tenant-a-ext-21', 'utterance', '{"text": "tenant-a の記憶 21 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:51.836+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ab70f9e5-e590-47b6-9ac0-e33600e28294', 'tenant-a', NULL, 'tenant-a-ext-22', 'utterance', '{"text": "tenant-a の記憶 22 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:51.841+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1d57fc61-4b98-49cf-a971-5a1a482e94c0', 'tenant-a', NULL, 'tenant-a-ext-23', 'utterance', '{"text": "tenant-a の記憶 23 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:51.848+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('76103319-fe1c-4607-9b92-458e99711a3d', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-10-07 19:12:51.855+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('5c69edff-14ab-4126-ae13-d8390e7d783a', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 0", "speaker": "user"}', NULL, '2026-10-07 19:12:51.972+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d0236ccf-7bb8-4f01-bd84-479b72b55bd0', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 1", "speaker": "user"}', NULL, '2026-10-07 19:12:51.978+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('53e2a9ee-6642-403a-a570-c34ec9ec206d', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 2", "speaker": "user"}', NULL, '2026-10-07 19:12:51.985+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('fca39289-58e9-4045-89d2-b20aa581e080', 'tenant-a', NULL, NULL, 'usage', '{"recallId": "458643c3-ee4f-410f-b5a7-8aefa8a2448c", "usedMemoryIds": ["400a62ea-1ab6-4d34-88dc-45c27c4bf60e"]}', NULL, '2026-10-07 19:12:52.057+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('89fe1cd5-2602-426b-be31-2e401867a9b4', 'tenant-b', NULL, 'tenant-b-ext-0', 'utterance', '{"text": "tenant-b の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:52.069+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('cf977ea6-1a38-484c-ba40-0574f09ac458', 'tenant-b', NULL, 'tenant-b-ext-1', 'utterance', '{"text": "tenant-b の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:52.076+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('518da3ba-bd83-4808-9312-272e38f54eae', 'tenant-b', NULL, 'tenant-b-ext-2', 'utterance', '{"text": "tenant-b の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:52.082+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('da6f82b5-3b5a-4826-b4a3-f5edbd5e66a7', 'tenant-b', NULL, 'tenant-b-ext-3', 'utterance', '{"text": "tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:52.089+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('921cdeb5-f983-4851-9d07-938825ae041d', 'tenant-b', NULL, 'tenant-b-ext-4', 'utterance', '{"text": "tenant-b の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:52.095+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('88220acf-e49d-472e-adc4-9d9f941d4b58', 'tenant-b', NULL, 'tenant-b-ext-5', 'utterance', '{"text": "tenant-b の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:52.104+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('68adba13-2b98-4121-a184-c38df6ed88f3', 'tenant-b', NULL, 'tenant-b-ext-6', 'utterance', '{"text": "tenant-b の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:52.113+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d4a6aac1-81c8-4624-bec5-7e80325c910c', 'tenant-b', NULL, 'tenant-b-ext-7', 'utterance', '{"text": "tenant-b の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:52.119+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e8fdff78-8168-4035-a428-282710724370', 'tenant-b', NULL, 'tenant-b-ext-8', 'utterance', '{"text": "tenant-b の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:52.125+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('bbb13b2e-a281-4d91-ad42-567edcc1ccdb', 'tenant-b', NULL, 'tenant-b-ext-9', 'utterance', '{"text": "tenant-b の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:52.146+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('cdad6ecd-9af2-4ca8-90cb-7d0afdb96ac5', 'tenant-b', NULL, 'tenant-b-ext-10', 'utterance', '{"text": "tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:52.158+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('3c1f1000-a08f-414b-aff7-6c59e3cf742e', 'tenant-b', NULL, 'tenant-b-ext-11', 'utterance', '{"text": "tenant-b の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:52.182+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1c809914-599d-42b7-a59b-28794884fc86', 'tenant-b', NULL, 'tenant-b-ext-12', 'utterance', '{"text": "tenant-b の記憶 12 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:52.241+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('7f73d7ba-b709-462c-82e7-b4115f1c1cf3', 'tenant-b', NULL, 'tenant-b-ext-13', 'utterance', '{"text": "tenant-b の記憶 13 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:52.254+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f3be50bf-a5b0-4e37-9411-98d9217d6afe', 'tenant-b', NULL, 'tenant-b-ext-14', 'utterance', '{"text": "tenant-b の記憶 14 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:52.263+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('7f53591d-2d1d-43fb-97e0-ab4b245ffcfc', 'tenant-b', NULL, 'tenant-b-ext-15', 'utterance', '{"text": "tenant-b の記憶 15 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:52.269+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('262d14e7-ebe4-4e2c-a3db-e5092b88a7d2', 'tenant-b', NULL, 'tenant-b-ext-16', 'utterance', '{"text": "tenant-b の記憶 16 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:52.279+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('5c28395e-b509-497d-a1cc-a5ab81358b8c', 'tenant-b', NULL, 'tenant-b-ext-17', 'utterance', '{"text": "tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:52.284+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0dd65950-e6dd-4476-b175-5a34913016e8', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-10-07 19:12:52.288+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('defd1013-2d3a-42b2-a7e9-3959482ef8a8', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 0", "speaker": "user"}', NULL, '2026-10-07 19:12:52.374+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('3ecf20ea-0a31-48a0-b9cd-a08cad357338', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 1", "speaker": "user"}', NULL, '2026-10-07 19:12:52.38+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0a5eb70c-2d21-4fbe-bbf1-def22ef7e7e9', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 2", "speaker": "user"}', NULL, '2026-10-07 19:12:52.385+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('78da2000-0ba2-40ff-84d9-90f1332ca8e4', 'tenant-b', NULL, NULL, 'usage', '{"recallId": "37260f26-e0d1-48f0-91f0-1304b831c3ce", "usedMemoryIds": ["54c374fa-f7b3-4db5-9a5c-4c8de3385bc7"]}', NULL, '2026-10-07 19:12:52.426+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b7e2918c-1d17-4ee6-8997-ffbbfd77f539', 'tenant-c', NULL, 'tenant-c-ext-0', 'utterance', '{"text": "tenant-c の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:52.432+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('51546901-6ab4-4ecf-8005-b753e6809f06', 'tenant-c', NULL, 'tenant-c-ext-1', 'utterance', '{"text": "tenant-c の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:52.438+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a213d506-819b-407d-a9ef-141bf80c965c', 'tenant-c', NULL, 'tenant-c-ext-2', 'utterance', '{"text": "tenant-c の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:52.447+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('27545251-2d0b-4651-ba1f-99eed32fcfef', 'tenant-c', NULL, 'tenant-c-ext-3', 'utterance', '{"text": "tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:52.454+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a651cc1e-69cd-4680-9a6d-192705e29bf4', 'tenant-c', NULL, 'tenant-c-ext-4', 'utterance', '{"text": "tenant-c の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:52.458+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1fcb8bd2-c114-477a-a370-58bfb6b97123', 'tenant-c', NULL, 'tenant-c-ext-5', 'utterance', '{"text": "tenant-c の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:52.463+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a5c0ab37-a6d5-4cdc-9509-cd89723b9d89', 'tenant-c', NULL, 'tenant-c-ext-6', 'utterance', '{"text": "tenant-c の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:52.468+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9ee72daa-0842-42d1-8d29-900b2aaa4afa', 'tenant-c', NULL, 'tenant-c-ext-7', 'utterance', '{"text": "tenant-c の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:52.474+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('86b6d267-2ea3-4c07-9eeb-383030097f3d', 'tenant-c', NULL, 'tenant-c-ext-8', 'utterance', '{"text": "tenant-c の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:52.481+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('656e297a-4352-420a-a704-0129ee2a0d2a', 'tenant-c', NULL, 'tenant-c-ext-9', 'utterance', '{"text": "tenant-c の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:52.486+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ea7ec8b5-b118-46e3-b0bf-07088df6b91d', 'tenant-c', NULL, 'tenant-c-ext-10', 'utterance', '{"text": "tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:52.495+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c1a01894-1ab7-4795-871e-b79b14f94dce', 'tenant-c', NULL, 'tenant-c-ext-11', 'utterance', '{"text": "tenant-c の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:52.501+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('846d54b0-52f3-4824-ac42-55d6bcd610a2', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-10-07 19:12:52.508+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1f78d7a5-2198-4466-94b5-585c307a7e04', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 0", "speaker": "user"}', NULL, '2026-10-07 19:12:52.569+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('845b6702-0924-4210-8f55-316cc5de1f13', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 1", "speaker": "user"}', NULL, '2026-10-07 19:12:52.577+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c6f74baa-6572-455d-ae7c-10be1cbeb8a2', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 2", "speaker": "user"}', NULL, '2026-10-07 19:12:52.583+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('84139ab8-9786-499b-966c-7c38b3fe39f2', 'tenant-c', NULL, NULL, 'usage', '{"recallId": "54c0b0ba-89ba-45dd-9823-52d0cae57b5b", "usedMemoryIds": ["43fba119-9a63-4595-bbea-66238cfe4009"]}', NULL, '2026-10-07 19:12:52.637+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('2d51a829-15a5-48f3-a788-08388c8107be', 'tenant-a2', NULL, 'tenant-a2-ext-0', 'utterance', '{"text": "tenant-a2 の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:52.644+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1a0649c2-d851-452a-9045-37f8d86d0e03', 'tenant-a2', NULL, 'tenant-a2-ext-1', 'utterance', '{"text": "tenant-a2 の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:52.651+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d2af2469-a243-41da-8ce3-95a21b50e1db', 'tenant-a2', NULL, 'tenant-a2-ext-2', 'utterance', '{"text": "tenant-a2 の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:52.657+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('fb4be86a-992d-4c6e-9d6d-9e925bd6f5e2', 'tenant-a2', NULL, 'tenant-a2-ext-3', 'utterance', '{"text": "tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:52.665+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('2100c358-6b7f-48bf-9f35-993271b9f5bf', 'tenant-a2', NULL, 'tenant-a2-ext-4', 'utterance', '{"text": "tenant-a2 の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:52.672+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6f3ebc30-c6cd-426b-a880-73d77d098e3f', 'tenant-a2', NULL, 'tenant-a2-ext-5', 'utterance', '{"text": "tenant-a2 の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:52.678+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('70c5dcc4-2b10-4fd1-bb01-d0c2e2a4e509', 'tenant-a2', NULL, 'tenant-a2-ext-6', 'utterance', '{"text": "tenant-a2 の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:52.684+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a0ec89f0-437b-4f8b-a6a3-d33c994d9188', 'tenant-a2', NULL, 'tenant-a2-ext-7', 'utterance', '{"text": "tenant-a2 の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:52.689+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('5aeaf542-a623-411e-ab60-9d8d3eec836d', 'tenant-a2', NULL, 'tenant-a2-ext-8', 'utterance', '{"text": "tenant-a2 の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:52.696+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e25c1728-d32d-434e-8f9f-da0740f96989', 'tenant-a2', NULL, 'tenant-a2-ext-9', 'utterance', '{"text": "tenant-a2 の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:52.703+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('5938f6cb-a78d-4810-a547-db58a810d2e2', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-10-07 19:12:52.711+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6758aa96-3ea1-4016-b661-4c897dd55bb4', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 0", "speaker": "user"}', NULL, '2026-10-07 19:12:52.769+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6b0f0d6d-3559-4834-a174-43d30fce1e9c', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 1", "speaker": "user"}', NULL, '2026-10-07 19:12:52.777+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('64d6558e-677f-4f5a-b6b9-3376bfcaf3d4', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 2", "speaker": "user"}', NULL, '2026-10-07 19:12:52.783+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a8e95a71-90f1-412c-a3f3-1e64cccb6f7b', 'tenant-a2', NULL, NULL, 'usage', '{"recallId": "d2feea5e-f297-46ca-a3f0-e69655a2f618", "usedMemoryIds": ["c3565db1-1d89-4840-92a4-72202a1d7d1b"]}', NULL, '2026-10-07 19:12:52.819+09', NULL, NULL, '{}');


--
-- Data for Name: outbox; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.outbox VALUES ('2cfe9331-725f-471a-9e0e-71ad9ebe3383', 'tenant-a', 'extract', '{"observationId": "9d1710c8-c82d-4418-a3b2-b4939e87f704"}', '2026-10-07 19:12:51.678+09', '2026-10-07 19:12:51.678+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.699+09', NULL, NULL, '2026-10-07 19:12:51.678+09');
INSERT INTO public.outbox VALUES ('3ca1cb5c-b9d3-4c2a-a07d-5907f2fb843f', 'tenant-a', 'extract', '{"observationId": "daae69af-69c0-45ff-99b8-4972d5ce6e45"}', '2026-10-07 19:12:51.7+09', '2026-10-07 19:12:51.7+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.707+09', NULL, NULL, '2026-10-07 19:12:51.7+09');
INSERT INTO public.outbox VALUES ('87153651-25c3-4b5b-889d-5b270ef9b7dd', 'tenant-a', 'extract', '{"observationId": "1d2d9caf-692c-4577-90d9-2db4913c712a"}', '2026-10-07 19:12:51.708+09', '2026-10-07 19:12:51.708+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.712+09', NULL, NULL, '2026-10-07 19:12:51.708+09');
INSERT INTO public.outbox VALUES ('69ec19d6-1241-44e0-a7f3-f8fece45cf8f', 'tenant-a', 'extract', '{"observationId": "b52ba63f-4a71-4e7b-af72-234d39a0095b"}', '2026-10-07 19:12:51.713+09', '2026-10-07 19:12:51.713+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.718+09', NULL, NULL, '2026-10-07 19:12:51.713+09');
INSERT INTO public.outbox VALUES ('176a3a60-32b6-4095-8a86-30ee2c521013', 'tenant-a', 'extract', '{"observationId": "0ec8b0b8-af1a-4b9e-b53f-aa73944085b1"}', '2026-10-07 19:12:51.719+09', '2026-10-07 19:12:51.719+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.723+09', NULL, NULL, '2026-10-07 19:12:51.719+09');
INSERT INTO public.outbox VALUES ('22a6517f-584e-4178-83c4-56ce50e0f857', 'tenant-a', 'extract', '{"observationId": "97d65c31-acfc-4a7b-8627-60eefe64e758"}', '2026-10-07 19:12:51.724+09', '2026-10-07 19:12:51.724+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.735+09', NULL, NULL, '2026-10-07 19:12:51.724+09');
INSERT INTO public.outbox VALUES ('c3eafc62-47e7-4a30-8624-3e8b6a71fab5', 'tenant-a', 'extract', '{"observationId": "8e4b04ea-597a-44f0-8f27-0d7bbfdc3f78"}', '2026-10-07 19:12:51.735+09', '2026-10-07 19:12:51.735+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.742+09', NULL, NULL, '2026-10-07 19:12:51.735+09');
INSERT INTO public.outbox VALUES ('d2ff3b91-3ec2-4ff3-b7e1-70ba938f7046', 'tenant-a', 'extract', '{"observationId": "29fcb6f2-0517-425f-b85e-caa82d1814a3"}', '2026-10-07 19:12:51.746+09', '2026-10-07 19:12:51.746+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.751+09', NULL, NULL, '2026-10-07 19:12:51.746+09');
INSERT INTO public.outbox VALUES ('52d7fccf-0703-4472-ac93-5f46c0a981a5', 'tenant-a', 'extract', '{"observationId": "715cfe5e-eb70-4e99-865a-91f1a30805d3"}', '2026-10-07 19:12:51.752+09', '2026-10-07 19:12:51.752+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.759+09', NULL, NULL, '2026-10-07 19:12:51.752+09');
INSERT INTO public.outbox VALUES ('539893e7-fac3-4507-ba08-eb670acc924c', 'tenant-a', 'extract', '{"observationId": "90008bba-3ae4-4f0a-bfc4-69037c3e0a1f"}', '2026-10-07 19:12:51.759+09', '2026-10-07 19:12:51.759+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.764+09', NULL, NULL, '2026-10-07 19:12:51.759+09');
INSERT INTO public.outbox VALUES ('7e011b25-1487-46b4-be4b-dfa7d6e02dca', 'tenant-a', 'extract', '{"observationId": "d47f19f5-8844-4f8c-b833-26651e293018"}', '2026-10-07 19:12:51.765+09', '2026-10-07 19:12:51.765+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.774+09', NULL, NULL, '2026-10-07 19:12:51.765+09');
INSERT INTO public.outbox VALUES ('00f4b109-7ad1-4b10-b107-0b873e60ec4c', 'tenant-a', 'extract', '{"observationId": "2a28d662-ebf6-4f86-b4fd-567127d47e80"}', '2026-10-07 19:12:51.775+09', '2026-10-07 19:12:51.775+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.781+09', NULL, NULL, '2026-10-07 19:12:51.775+09');
INSERT INTO public.outbox VALUES ('f541d5cb-efd5-4f1e-bf19-ca7768bc25d4', 'tenant-a', 'extract', '{"observationId": "ecfa5245-ce1d-407c-824d-c1a1164961cf"}', '2026-10-07 19:12:51.781+09', '2026-10-07 19:12:51.781+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.787+09', NULL, NULL, '2026-10-07 19:12:51.781+09');
INSERT INTO public.outbox VALUES ('d68d18c7-a75d-4c39-89c5-fa2c6a1774bc', 'tenant-a', 'extract', '{"observationId": "bda1a8c6-709a-4900-b090-7ccd8b64e030"}', '2026-10-07 19:12:51.788+09', '2026-10-07 19:12:51.788+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.794+09', NULL, NULL, '2026-10-07 19:12:51.788+09');
INSERT INTO public.outbox VALUES ('e5f3616f-3db6-4713-849c-3acd29bdaf9c', 'tenant-a', 'extract', '{"observationId": "03427a62-292e-45ba-9967-f214dadd233c"}', '2026-10-07 19:12:51.795+09', '2026-10-07 19:12:51.795+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.802+09', NULL, NULL, '2026-10-07 19:12:51.795+09');
INSERT INTO public.outbox VALUES ('fbf99e11-d511-458c-95f4-aeab20a38d0e', 'tenant-a', 'extract', '{"observationId": "e516bf03-b0d5-4104-9048-17b22e32b58e"}', '2026-10-07 19:12:51.803+09', '2026-10-07 19:12:51.803+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.809+09', NULL, NULL, '2026-10-07 19:12:51.803+09');
INSERT INTO public.outbox VALUES ('3469ae2c-d308-44b9-9b3c-f8fd9625bac4', 'tenant-a', 'extract', '{"observationId": "a66c556d-2f87-47f0-ad6d-53ae2a7cba68"}', '2026-10-07 19:12:51.81+09', '2026-10-07 19:12:51.81+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.815+09', NULL, NULL, '2026-10-07 19:12:51.81+09');
INSERT INTO public.outbox VALUES ('3e49eb77-76de-427b-b6b5-765369c809eb', 'tenant-a', 'extract', '{"observationId": "1c16d7b9-77db-4492-a4c2-b0a87c3bb3c2"}', '2026-10-07 19:12:51.816+09', '2026-10-07 19:12:51.816+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.82+09', NULL, NULL, '2026-10-07 19:12:51.816+09');
INSERT INTO public.outbox VALUES ('eefb632e-a0eb-4819-9739-3ec1ebdf441a', 'tenant-a', 'extract', '{"observationId": "7807148b-fd04-4d27-b84f-1030e74e1a55"}', '2026-10-07 19:12:51.821+09', '2026-10-07 19:12:51.821+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.826+09', NULL, NULL, '2026-10-07 19:12:51.821+09');
INSERT INTO public.outbox VALUES ('168b0712-aaca-44b0-bed7-136d43fe6f16', 'tenant-a', 'extract', '{"observationId": "ae8fee43-0288-436f-9286-f00ad62bc188"}', '2026-10-07 19:12:51.826+09', '2026-10-07 19:12:51.826+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.83+09', NULL, NULL, '2026-10-07 19:12:51.826+09');
INSERT INTO public.outbox VALUES ('192abc62-c91c-46af-9d39-c88f0f8edd3c', 'tenant-a', 'extract', '{"observationId": "0c4c0422-c503-4ffb-9333-9890df324c0d"}', '2026-10-07 19:12:51.831+09', '2026-10-07 19:12:51.831+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.836+09', NULL, NULL, '2026-10-07 19:12:51.831+09');
INSERT INTO public.outbox VALUES ('0a0c3aff-8e62-4b44-882d-b4e24c1a9357', 'tenant-a', 'extract', '{"observationId": "a5b6653b-8006-4503-bfa4-7c179e6c90fc"}', '2026-10-07 19:12:51.836+09', '2026-10-07 19:12:51.836+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.84+09', NULL, NULL, '2026-10-07 19:12:51.836+09');
INSERT INTO public.outbox VALUES ('b30cc0f9-26ca-44c4-a5dc-60caa5ed1776', 'tenant-a', 'extract', '{"observationId": "ab70f9e5-e590-47b6-9ac0-e33600e28294"}', '2026-10-07 19:12:51.841+09', '2026-10-07 19:12:51.841+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.847+09', NULL, NULL, '2026-10-07 19:12:51.841+09');
INSERT INTO public.outbox VALUES ('8163c00d-a71e-42d0-8c35-57909588987d', 'tenant-a', 'embed', '{"memoryId": "2fbb63f9-0722-4677-bab2-8d3b7533f9f8"}', '2026-10-07 19:12:51.688+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.871+09', NULL, NULL, '2026-10-07 19:12:51.688+09');
INSERT INTO public.outbox VALUES ('0130eca7-810e-4db5-a1de-d854c116fbe1', 'tenant-a', 'extract', '{"observationId": "1d57fc61-4b98-49cf-a971-5a1a482e94c0"}', '2026-10-07 19:12:51.848+09', '2026-10-07 19:12:51.848+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.854+09', NULL, NULL, '2026-10-07 19:12:51.848+09');
INSERT INTO public.outbox VALUES ('4eddf649-b04f-4086-a5d3-c9a2760615b1', 'tenant-a', 'extract', '{"observationId": "76103319-fe1c-4607-9b92-458e99711a3d"}', '2026-10-07 19:12:51.855+09', '2026-10-07 19:12:51.855+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.863+09', NULL, NULL, '2026-10-07 19:12:51.855+09');
INSERT INTO public.outbox VALUES ('ce3f43cd-cfd5-47e2-b9a7-73e473cdfb48', 'tenant-a', 'embed', '{"memoryId": "7758338c-58cb-4fc7-8bbe-1392d468e32c"}', '2026-10-07 19:12:51.703+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.874+09', NULL, NULL, '2026-10-07 19:12:51.703+09');
INSERT INTO public.outbox VALUES ('c07ccd23-872a-43a9-8b2d-9dc4ddcce0df', 'tenant-a', 'embed', '{"memoryId": "9e5e0ceb-69d0-4469-9673-6d333ffe6575"}', '2026-10-07 19:12:51.709+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.878+09', NULL, NULL, '2026-10-07 19:12:51.709+09');
INSERT INTO public.outbox VALUES ('5f306b0d-126c-4165-a9b3-a2a5f8c57474', 'tenant-a', 'embed', '{"memoryId": "b0ebb353-77af-487e-bc5e-644be85d3c7a"}', '2026-10-07 19:12:51.715+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.881+09', NULL, NULL, '2026-10-07 19:12:51.715+09');
INSERT INTO public.outbox VALUES ('ba02193e-ad1f-4e85-9ca5-c2ea7af9fd92', 'tenant-a', 'embed', '{"memoryId": "a5a0aa63-a181-43dd-966b-c2d7b2e8b773"}', '2026-10-07 19:12:51.72+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.884+09', NULL, NULL, '2026-10-07 19:12:51.72+09');
INSERT INTO public.outbox VALUES ('e558a9ec-c847-497a-a50d-6523b43badbc', 'tenant-a', 'embed', '{"memoryId": "58ec7654-8f38-4c2e-adb6-309bccf32956"}', '2026-10-07 19:12:51.726+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.888+09', NULL, NULL, '2026-10-07 19:12:51.726+09');
INSERT INTO public.outbox VALUES ('718fd491-7631-4e9d-af2c-5ff231dca4a4', 'tenant-a', 'embed', '{"memoryId": "01767b15-4fd2-438b-86d7-ac0312ea6421"}', '2026-10-07 19:12:51.738+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.892+09', NULL, NULL, '2026-10-07 19:12:51.738+09');
INSERT INTO public.outbox VALUES ('fc82019b-3243-41b2-9cb1-1ec525de9471', 'tenant-a', 'embed', '{"memoryId": "fcd8b5e4-3c5e-41ea-bbaa-0817d76d824c"}', '2026-10-07 19:12:51.748+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.895+09', NULL, NULL, '2026-10-07 19:12:51.748+09');
INSERT INTO public.outbox VALUES ('3b60e0d7-4375-4b14-b63e-823cb51728c8', 'tenant-a', 'embed', '{"memoryId": "3aad2359-9ce5-47d3-8499-3d122b931d75"}', '2026-10-07 19:12:51.755+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.9+09', NULL, NULL, '2026-10-07 19:12:51.755+09');
INSERT INTO public.outbox VALUES ('e5630bbf-47ea-41ff-a7bb-1bb4ff360ab0', 'tenant-a', 'embed', '{"memoryId": "aeb13a03-10a2-42c9-8a8f-31bd47e15b05"}', '2026-10-07 19:12:51.761+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.903+09', NULL, NULL, '2026-10-07 19:12:51.761+09');
INSERT INTO public.outbox VALUES ('7d1581b1-41de-4477-a9a7-4e4a5a6bd447', 'tenant-a', 'embed', '{"memoryId": "6ce3006a-5038-44f3-95b0-37cce6eb5b81"}', '2026-10-07 19:12:51.769+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.909+09', NULL, NULL, '2026-10-07 19:12:51.769+09');
INSERT INTO public.outbox VALUES ('a3f3fc2c-9f51-4154-a3c5-ba3e17a3f4fb', 'tenant-a', 'embed', '{"memoryId": "28d469b7-5c04-42f8-b519-b9d6fd6fd888"}', '2026-10-07 19:12:51.777+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.918+09', NULL, NULL, '2026-10-07 19:12:51.777+09');
INSERT INTO public.outbox VALUES ('2a17cb6e-3262-4879-9c00-3f0440197f7a', 'tenant-a', 'embed', '{"memoryId": "c8a9eeb5-ed23-4c73-9df3-a30482aa550f"}', '2026-10-07 19:12:51.784+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.922+09', NULL, NULL, '2026-10-07 19:12:51.784+09');
INSERT INTO public.outbox VALUES ('8d842dc0-cb00-4cd7-b8dc-81b13b9405ca', 'tenant-a', 'embed', '{"memoryId": "1f155584-eb38-4b19-a539-45252c8b2d02"}', '2026-10-07 19:12:51.791+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.926+09', NULL, NULL, '2026-10-07 19:12:51.791+09');
INSERT INTO public.outbox VALUES ('814a73a4-270d-493c-bee7-4b954d35a58d', 'tenant-a', 'embed', '{"memoryId": "66a39a9a-cee2-4d2a-83d1-e74a795f2069"}', '2026-10-07 19:12:51.798+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.929+09', NULL, NULL, '2026-10-07 19:12:51.798+09');
INSERT INTO public.outbox VALUES ('99d8b083-c3e2-466c-8166-4423d6ffc4d1', 'tenant-a', 'embed', '{"memoryId": "ae8e9716-84e9-47f3-a501-596a9b524ff5"}', '2026-10-07 19:12:51.806+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.932+09', NULL, NULL, '2026-10-07 19:12:51.806+09');
INSERT INTO public.outbox VALUES ('e95bc22c-1ab9-4aba-a443-009baf55d378', 'tenant-a', 'embed', '{"memoryId": "a877a726-3af7-4c82-9e2e-074cd07ab8cb"}', '2026-10-07 19:12:51.812+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.936+09', NULL, NULL, '2026-10-07 19:12:51.812+09');
INSERT INTO public.outbox VALUES ('961153aa-c16d-4ddc-aac3-4d0ce318919b', 'tenant-a', 'embed', '{"memoryId": "b7adc42b-6c36-489a-abd9-318425688272"}', '2026-10-07 19:12:51.817+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.939+09', NULL, NULL, '2026-10-07 19:12:51.817+09');
INSERT INTO public.outbox VALUES ('7d5db15b-a206-48e4-8e04-2638913c6d4d', 'tenant-a', 'embed', '{"memoryId": "f164a835-0ac4-48e1-a09d-4e2b161b1ce1"}', '2026-10-07 19:12:51.823+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.941+09', NULL, NULL, '2026-10-07 19:12:51.823+09');
INSERT INTO public.outbox VALUES ('ee1fb9d8-db81-4394-a411-43eea39e619a', 'tenant-a', 'embed', '{"memoryId": "a800507b-204e-4829-9160-ebd0e307c892"}', '2026-10-07 19:12:51.828+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.947+09', NULL, NULL, '2026-10-07 19:12:51.828+09');
INSERT INTO public.outbox VALUES ('281df252-ede6-4c84-8f12-cf26e299a391', 'tenant-a', 'embed', '{"memoryId": "400a62ea-1ab6-4d34-88dc-45c27c4bf60e"}', '2026-10-07 19:12:51.833+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.951+09', NULL, NULL, '2026-10-07 19:12:51.833+09');
INSERT INTO public.outbox VALUES ('9bb45c04-2ba3-472d-8504-2998991ea8ba', 'tenant-a', 'embed', '{"memoryId": "09d4c803-84ed-45fb-8cd9-2342917e0943"}', '2026-10-07 19:12:51.838+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.954+09', NULL, NULL, '2026-10-07 19:12:51.838+09');
INSERT INTO public.outbox VALUES ('5c404ece-9919-4f40-9149-3fac27acf0fa', 'tenant-a', 'embed', '{"memoryId": "60a9be4a-b274-481d-a7fa-1beef08a824c"}', '2026-10-07 19:12:51.844+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.959+09', NULL, NULL, '2026-10-07 19:12:51.844+09');
INSERT INTO public.outbox VALUES ('1ce028ec-f118-47ee-a1c8-ed69e7b22056', 'tenant-a', 'embed', '{"memoryId": "464e8b6a-e223-4946-ab92-c30c8c7d6d0c"}', '2026-10-07 19:12:51.85+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, '2026-10-07 19:12:51.967+09', NULL, NULL, '2026-10-07 19:12:51.85+09');
INSERT INTO public.outbox VALUES ('8d92c9a1-579f-45aa-9b8c-77b5f39e25d9', 'tenant-a', 'embed', '{"memoryId": "b02b0fa2-fa68-4505-a998-efe8ac11f6d0"}', '2026-10-07 19:12:51.859+09', '2026-10-07 19:12:51.864+09', 'runtime.tick', 1, NULL, '2026-10-07 19:12:51.971+09', 'fixture: embedding provider failure', '2026-10-07 19:12:51.859+09');
INSERT INTO public.outbox VALUES ('47b51a64-6ae3-4bdb-890b-bc1c98832a04', 'tenant-a', 'embed', '{"memoryId": "09e42cf5-58dd-496c-8f0e-ca2db70fea87"}', '2026-10-07 19:12:51.974+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:51.974+09');
INSERT INTO public.outbox VALUES ('711d2e9b-74d6-463e-8c96-bf22d315823c', 'tenant-a', 'extract', '{"observationId": "5c69edff-14ab-4126-ae13-d8390e7d783a"}', '2026-10-07 19:12:51.972+09', '2026-10-07 19:12:51.972+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.978+09', NULL, NULL, '2026-10-07 19:12:51.972+09');
INSERT INTO public.outbox VALUES ('bbde69e3-b7ac-4502-9c17-f854ffe6f002', 'tenant-a', 'embed', '{"memoryId": "8bbf52e0-3f71-4492-a289-0cc9c0d21309"}', '2026-10-07 19:12:51.98+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:51.98+09');
INSERT INTO public.outbox VALUES ('35d6f109-729c-44f6-8f0f-d79be69a9e6a', 'tenant-a', 'extract', '{"observationId": "d0236ccf-7bb8-4f01-bd84-479b72b55bd0"}', '2026-10-07 19:12:51.978+09', '2026-10-07 19:12:51.978+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.984+09', NULL, NULL, '2026-10-07 19:12:51.978+09');
INSERT INTO public.outbox VALUES ('62d530ba-f224-4e21-81a2-df9a5f6579e8', 'tenant-a', 'embed', '{"memoryId": "74bb4b4c-9f10-453b-83a5-7c751a5e6634"}', '2026-10-07 19:12:51.987+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:51.987+09');
INSERT INTO public.outbox VALUES ('c42c9d5f-5673-4cac-9a61-1f6c590dd14b', 'tenant-a', 'extract', '{"observationId": "53e2a9ee-6642-403a-a570-c34ec9ec206d"}', '2026-10-07 19:12:51.985+09', '2026-10-07 19:12:51.985+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:51.991+09', NULL, NULL, '2026-10-07 19:12:51.985+09');
INSERT INTO public.outbox VALUES ('9bb41bb1-4bdf-4a5a-9858-04dedf057b95', 'tenant-b', 'extract', '{"observationId": "89fe1cd5-2602-426b-be31-2e401867a9b4"}', '2026-10-07 19:12:52.069+09', '2026-10-07 19:12:52.069+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.075+09', NULL, NULL, '2026-10-07 19:12:52.069+09');
INSERT INTO public.outbox VALUES ('2f3d8b6b-bb76-4caf-a8ff-825acf31d5da', 'tenant-b', 'extract', '{"observationId": "cf977ea6-1a38-484c-ba40-0574f09ac458"}', '2026-10-07 19:12:52.076+09', '2026-10-07 19:12:52.076+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.081+09', NULL, NULL, '2026-10-07 19:12:52.076+09');
INSERT INTO public.outbox VALUES ('bbdb550c-39ed-4bc1-a488-9bd8ecc0d2f3', 'tenant-b', 'extract', '{"observationId": "518da3ba-bd83-4808-9312-272e38f54eae"}', '2026-10-07 19:12:52.082+09', '2026-10-07 19:12:52.082+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.088+09', NULL, NULL, '2026-10-07 19:12:52.082+09');
INSERT INTO public.outbox VALUES ('d20ee041-b632-403c-8312-4a262933d26c', 'tenant-b', 'extract', '{"observationId": "da6f82b5-3b5a-4826-b4a3-f5edbd5e66a7"}', '2026-10-07 19:12:52.089+09', '2026-10-07 19:12:52.089+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.094+09', NULL, NULL, '2026-10-07 19:12:52.089+09');
INSERT INTO public.outbox VALUES ('4aee192f-cb78-464d-a153-d15a72dac1c0', 'tenant-b', 'extract', '{"observationId": "921cdeb5-f983-4851-9d07-938825ae041d"}', '2026-10-07 19:12:52.095+09', '2026-10-07 19:12:52.095+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.102+09', NULL, NULL, '2026-10-07 19:12:52.095+09');
INSERT INTO public.outbox VALUES ('b4eeef97-55de-4205-9749-5a88d1e8f59e', 'tenant-b', 'extract', '{"observationId": "88220acf-e49d-472e-adc4-9d9f941d4b58"}', '2026-10-07 19:12:52.104+09', '2026-10-07 19:12:52.104+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.112+09', NULL, NULL, '2026-10-07 19:12:52.104+09');
INSERT INTO public.outbox VALUES ('2c07bc4a-a2ca-442f-afd5-fda85b25c8cb', 'tenant-b', 'embed', '{"memoryId": "c10b7458-aef5-4886-a8e4-f339ab991e81"}', '2026-10-07 19:12:52.072+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.298+09', NULL, NULL, '2026-10-07 19:12:52.072+09');
INSERT INTO public.outbox VALUES ('2d6d793a-a6f6-4b37-9b70-1a4aaa20482d', 'tenant-b', 'extract', '{"observationId": "68adba13-2b98-4121-a184-c38df6ed88f3"}', '2026-10-07 19:12:52.113+09', '2026-10-07 19:12:52.113+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.118+09', NULL, NULL, '2026-10-07 19:12:52.113+09');
INSERT INTO public.outbox VALUES ('94450f4e-4850-462b-9a03-3734b023fd9d', 'tenant-b', 'extract', '{"observationId": "d4a6aac1-81c8-4624-bec5-7e80325c910c"}', '2026-10-07 19:12:52.119+09', '2026-10-07 19:12:52.119+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.124+09', NULL, NULL, '2026-10-07 19:12:52.119+09');
INSERT INTO public.outbox VALUES ('7975d078-8129-431f-aa6f-646d067d00d0', 'tenant-b', 'extract', '{"observationId": "e8fdff78-8168-4035-a428-282710724370"}', '2026-10-07 19:12:52.125+09', '2026-10-07 19:12:52.125+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.134+09', NULL, NULL, '2026-10-07 19:12:52.125+09');
INSERT INTO public.outbox VALUES ('58f44f9d-e1e6-4da5-b4b7-a48a31ea56b1', 'tenant-b', 'extract', '{"observationId": "bbb13b2e-a281-4d91-ad42-567edcc1ccdb"}', '2026-10-07 19:12:52.146+09', '2026-10-07 19:12:52.146+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.157+09', NULL, NULL, '2026-10-07 19:12:52.146+09');
INSERT INTO public.outbox VALUES ('03c67908-a855-49d3-b903-f407ad620a8c', 'tenant-b', 'extract', '{"observationId": "cdad6ecd-9af2-4ca8-90cb-7d0afdb96ac5"}', '2026-10-07 19:12:52.158+09', '2026-10-07 19:12:52.158+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.179+09', NULL, NULL, '2026-10-07 19:12:52.158+09');
INSERT INTO public.outbox VALUES ('363febe3-7b48-4082-ae19-ba7cebacd415', 'tenant-b', 'extract', '{"observationId": "3c1f1000-a08f-414b-aff7-6c59e3cf742e"}', '2026-10-07 19:12:52.182+09', '2026-10-07 19:12:52.182+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.198+09', NULL, NULL, '2026-10-07 19:12:52.182+09');
INSERT INTO public.outbox VALUES ('c3b4ab14-af1f-4878-8545-f2be78811b0c', 'tenant-b', 'extract', '{"observationId": "1c809914-599d-42b7-a59b-28794884fc86"}', '2026-10-07 19:12:52.241+09', '2026-10-07 19:12:52.241+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.252+09', NULL, NULL, '2026-10-07 19:12:52.241+09');
INSERT INTO public.outbox VALUES ('242dafc3-ae48-47f1-a080-5032a01cd2d9', 'tenant-b', 'extract', '{"observationId": "7f73d7ba-b709-462c-82e7-b4115f1c1cf3"}', '2026-10-07 19:12:52.254+09', '2026-10-07 19:12:52.254+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.263+09', NULL, NULL, '2026-10-07 19:12:52.254+09');
INSERT INTO public.outbox VALUES ('f3f46b8c-d6c8-41be-83d2-e41d6f5e7f7c', 'tenant-b', 'extract', '{"observationId": "f3be50bf-a5b0-4e37-9411-98d9217d6afe"}', '2026-10-07 19:12:52.263+09', '2026-10-07 19:12:52.263+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.268+09', NULL, NULL, '2026-10-07 19:12:52.263+09');
INSERT INTO public.outbox VALUES ('f6835e6d-21a0-4ec7-bbab-a6c26f3d8969', 'tenant-b', 'extract', '{"observationId": "7f53591d-2d1d-43fb-97e0-ab4b245ffcfc"}', '2026-10-07 19:12:52.269+09', '2026-10-07 19:12:52.269+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.278+09', NULL, NULL, '2026-10-07 19:12:52.269+09');
INSERT INTO public.outbox VALUES ('a54e1e6f-07cc-4e69-87af-ff3ffa9fa620', 'tenant-b', 'extract', '{"observationId": "262d14e7-ebe4-4e2c-a3db-e5092b88a7d2"}', '2026-10-07 19:12:52.279+09', '2026-10-07 19:12:52.279+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.283+09', NULL, NULL, '2026-10-07 19:12:52.279+09');
INSERT INTO public.outbox VALUES ('323ce261-fd24-4099-b86f-49b564cfd35c', 'tenant-b', 'extract', '{"observationId": "5c28395e-b509-497d-a1cc-a5ab81358b8c"}', '2026-10-07 19:12:52.284+09', '2026-10-07 19:12:52.284+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.288+09', NULL, NULL, '2026-10-07 19:12:52.284+09');
INSERT INTO public.outbox VALUES ('3c452e1a-d201-4c98-b33f-379aa1ac28a6', 'tenant-b', 'extract', '{"observationId": "0dd65950-e6dd-4476-b175-5a34913016e8"}', '2026-10-07 19:12:52.288+09', '2026-10-07 19:12:52.288+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.292+09', NULL, NULL, '2026-10-07 19:12:52.288+09');
INSERT INTO public.outbox VALUES ('65d47fd8-8410-489c-8492-90ad1c00772c', 'tenant-b', 'embed', '{"memoryId": "f7e7c94a-0411-49ec-9dbe-12585c3ddf78"}', '2026-10-07 19:12:52.078+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.301+09', NULL, NULL, '2026-10-07 19:12:52.078+09');
INSERT INTO public.outbox VALUES ('64846cef-ca13-4272-9b53-0645600fc25f', 'tenant-b', 'embed', '{"memoryId": "528b2953-538b-46e9-bb90-7d2962241368"}', '2026-10-07 19:12:52.085+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.308+09', NULL, NULL, '2026-10-07 19:12:52.085+09');
INSERT INTO public.outbox VALUES ('548d9dbd-1370-4b49-8743-2de2ff3917e8', 'tenant-b', 'embed', '{"memoryId": "99ef7e87-2791-47f2-aa14-3dda1f2986d3"}', '2026-10-07 19:12:52.091+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.316+09', NULL, NULL, '2026-10-07 19:12:52.091+09');
INSERT INTO public.outbox VALUES ('0ca430e1-764d-4d12-9241-cfd5b45da047', 'tenant-b', 'embed', '{"memoryId": "ace9fecc-db87-4cf4-ba51-15341c4d9170"}', '2026-10-07 19:12:52.097+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.323+09', NULL, NULL, '2026-10-07 19:12:52.097+09');
INSERT INTO public.outbox VALUES ('142bf564-4800-4ce8-8ceb-b927a570be9d', 'tenant-b', 'embed', '{"memoryId": "3162294f-c08c-40e0-a234-4bcf93cda901"}', '2026-10-07 19:12:52.108+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.326+09', NULL, NULL, '2026-10-07 19:12:52.108+09');
INSERT INTO public.outbox VALUES ('4d11182d-63d8-4404-928f-ce0ed79bbc36', 'tenant-b', 'embed', '{"memoryId": "2345525e-c383-4053-9786-b90220bda018"}', '2026-10-07 19:12:52.115+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.329+09', NULL, NULL, '2026-10-07 19:12:52.115+09');
INSERT INTO public.outbox VALUES ('216387fc-6574-4bcd-960a-6619d4861269', 'tenant-b', 'embed', '{"memoryId": "d5a955fb-8a2d-4724-8ce8-5ea29765ddf4"}', '2026-10-07 19:12:52.121+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.332+09', NULL, NULL, '2026-10-07 19:12:52.121+09');
INSERT INTO public.outbox VALUES ('2e80decd-24f3-4f67-aa57-16d771ac5aaf', 'tenant-b', 'embed', '{"memoryId": "213f102f-6494-46a8-a329-7184d3c1c791"}', '2026-10-07 19:12:52.128+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.335+09', NULL, NULL, '2026-10-07 19:12:52.128+09');
INSERT INTO public.outbox VALUES ('1ea4d6f8-472f-4a28-bb9b-2c40b77accf5', 'tenant-b', 'embed', '{"memoryId": "7633e5f4-f718-4997-8dd0-ef5df5925b28"}', '2026-10-07 19:12:52.152+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.339+09', NULL, NULL, '2026-10-07 19:12:52.152+09');
INSERT INTO public.outbox VALUES ('2a363503-1fd8-4cad-8f6b-9cc74f79cc5f', 'tenant-b', 'embed', '{"memoryId": "bd770266-dd60-4236-9770-60f3ab636c27"}', '2026-10-07 19:12:52.166+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.342+09', NULL, NULL, '2026-10-07 19:12:52.166+09');
INSERT INTO public.outbox VALUES ('8ba49a86-f374-4d79-987c-914ecc3d06d3', 'tenant-b', 'embed', '{"memoryId": "74ad85f3-2bed-4993-b600-dfa269edb9af"}', '2026-10-07 19:12:52.193+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.347+09', NULL, NULL, '2026-10-07 19:12:52.193+09');
INSERT INTO public.outbox VALUES ('0d74e80e-1bba-4aee-a8a1-1ff0ca9dd2da', 'tenant-b', 'embed', '{"memoryId": "3757a0f2-1d20-4ed8-96d6-cea64cf1e1b0"}', '2026-10-07 19:12:52.248+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.352+09', NULL, NULL, '2026-10-07 19:12:52.248+09');
INSERT INTO public.outbox VALUES ('6e77b25c-9b83-42f8-9ed2-1d4d76388a41', 'tenant-b', 'embed', '{"memoryId": "07758de0-0b13-4eb4-8130-3d24ce222d05"}', '2026-10-07 19:12:52.26+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.357+09', NULL, NULL, '2026-10-07 19:12:52.26+09');
INSERT INTO public.outbox VALUES ('6b89329d-c0ca-4179-86a2-20d1fc6cedfa', 'tenant-b', 'embed', '{"memoryId": "54c374fa-f7b3-4db5-9a5c-4c8de3385bc7"}', '2026-10-07 19:12:52.265+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.361+09', NULL, NULL, '2026-10-07 19:12:52.265+09');
INSERT INTO public.outbox VALUES ('011038a0-0dda-41d5-8527-0140bb0f60e5', 'tenant-b', 'embed', '{"memoryId": "8a9121da-4b25-476e-bdf0-dda5f7b43ce3"}', '2026-10-07 19:12:52.272+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.364+09', NULL, NULL, '2026-10-07 19:12:52.272+09');
INSERT INTO public.outbox VALUES ('01773f29-4e38-48ab-829b-11ab20aadad8', 'tenant-b', 'embed', '{"memoryId": "d917c811-ee4e-47ba-b95e-eeb1af32515f"}', '2026-10-07 19:12:52.28+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.367+09', NULL, NULL, '2026-10-07 19:12:52.28+09');
INSERT INTO public.outbox VALUES ('f10d5a79-9192-4edb-ba47-0fc9fd47e621', 'tenant-b', 'embed', '{"memoryId": "58cc3a78-bdc4-4f49-80b0-c4b5bf0446ab"}', '2026-10-07 19:12:52.285+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, '2026-10-07 19:12:52.372+09', NULL, NULL, '2026-10-07 19:12:52.285+09');
INSERT INTO public.outbox VALUES ('f6f830fc-fd00-4811-afa0-cd7452f4bd9d', 'tenant-b', 'embed', '{"memoryId": "76c5a046-8a29-4efa-8313-0798f4f706ae"}', '2026-10-07 19:12:52.29+09', '2026-10-07 19:12:52.293+09', 'runtime.tick', 1, NULL, '2026-10-07 19:12:52.374+09', 'fixture: embedding provider failure', '2026-10-07 19:12:52.29+09');
INSERT INTO public.outbox VALUES ('0ef16cdd-cc2e-4697-9a1e-7a4bd6a43752', 'tenant-b', 'embed', '{"memoryId": "1dc03000-9b4f-465d-86da-c76b90217646"}', '2026-10-07 19:12:52.377+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:52.377+09');
INSERT INTO public.outbox VALUES ('13d5f23f-810c-467e-a24d-d5db465156ac', 'tenant-b', 'extract', '{"observationId": "defd1013-2d3a-42b2-a7e9-3959482ef8a8"}', '2026-10-07 19:12:52.374+09', '2026-10-07 19:12:52.374+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.379+09', NULL, NULL, '2026-10-07 19:12:52.374+09');
INSERT INTO public.outbox VALUES ('926852bb-a321-4122-b055-f9543334f24f', 'tenant-b', 'embed', '{"memoryId": "4ab8047e-cd2d-4c71-8c8d-1cfe2e0acd2a"}', '2026-10-07 19:12:52.382+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:52.382+09');
INSERT INTO public.outbox VALUES ('ee20f47f-266d-4bc8-88b9-39357079f101', 'tenant-b', 'extract', '{"observationId": "3ecf20ea-0a31-48a0-b9cd-a08cad357338"}', '2026-10-07 19:12:52.38+09', '2026-10-07 19:12:52.38+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.385+09', NULL, NULL, '2026-10-07 19:12:52.38+09');
INSERT INTO public.outbox VALUES ('2c4748c2-411d-4ff6-ab9d-ddf70cfac7b4', 'tenant-b', 'embed', '{"memoryId": "4c8e161d-6af2-442c-8c6f-35239c511284"}', '2026-10-07 19:12:52.387+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:52.387+09');
INSERT INTO public.outbox VALUES ('f0b2b8a4-f61d-48f7-87dc-181e44b7bcc9', 'tenant-b', 'extract', '{"observationId": "0a5eb70c-2d21-4fbe-bbf1-def22ef7e7e9"}', '2026-10-07 19:12:52.385+09', '2026-10-07 19:12:52.385+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.39+09', NULL, NULL, '2026-10-07 19:12:52.385+09');
INSERT INTO public.outbox VALUES ('3a8ee5c7-30a0-46d5-9453-a48f9da79446', 'tenant-c', 'extract', '{"observationId": "b7e2918c-1d17-4ee6-8997-ffbbfd77f539"}', '2026-10-07 19:12:52.432+09', '2026-10-07 19:12:52.432+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.437+09', NULL, NULL, '2026-10-07 19:12:52.432+09');
INSERT INTO public.outbox VALUES ('5e6fc911-5969-4d3d-91db-6941b7f810d1', 'tenant-c', 'extract', '{"observationId": "51546901-6ab4-4ecf-8005-b753e6809f06"}', '2026-10-07 19:12:52.438+09', '2026-10-07 19:12:52.438+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.447+09', NULL, NULL, '2026-10-07 19:12:52.438+09');
INSERT INTO public.outbox VALUES ('7a7f4452-ae2e-4643-974d-705a2a239c86', 'tenant-c', 'extract', '{"observationId": "a213d506-819b-407d-a9ef-141bf80c965c"}', '2026-10-07 19:12:52.447+09', '2026-10-07 19:12:52.447+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.453+09', NULL, NULL, '2026-10-07 19:12:52.447+09');
INSERT INTO public.outbox VALUES ('138b348d-99ef-4279-b7fe-220da3bea2af', 'tenant-c', 'embed', '{"memoryId": "acf6281f-843b-4c01-be93-d6f4a2a1be04"}', '2026-10-07 19:12:52.434+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, '2026-10-07 19:12:52.517+09', NULL, NULL, '2026-10-07 19:12:52.434+09');
INSERT INTO public.outbox VALUES ('7233cd7a-3034-4b4b-8193-fa7164385b1c', 'tenant-c', 'extract', '{"observationId": "27545251-2d0b-4651-ba1f-99eed32fcfef"}', '2026-10-07 19:12:52.454+09', '2026-10-07 19:12:52.454+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.457+09', NULL, NULL, '2026-10-07 19:12:52.454+09');
INSERT INTO public.outbox VALUES ('1fcb19ce-0f91-4cbd-aaf1-c2faaa10e7a1', 'tenant-c', 'extract', '{"observationId": "a651cc1e-69cd-4680-9a6d-192705e29bf4"}', '2026-10-07 19:12:52.458+09', '2026-10-07 19:12:52.458+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.462+09', NULL, NULL, '2026-10-07 19:12:52.458+09');
INSERT INTO public.outbox VALUES ('fef3b18d-804f-4f26-b5d8-ad9f4d4450c4', 'tenant-c', 'extract', '{"observationId": "1fcb8bd2-c114-477a-a370-58bfb6b97123"}', '2026-10-07 19:12:52.463+09', '2026-10-07 19:12:52.463+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.467+09', NULL, NULL, '2026-10-07 19:12:52.463+09');
INSERT INTO public.outbox VALUES ('136a4a80-3077-4aa5-9207-0c32ae5754ed', 'tenant-c', 'extract', '{"observationId": "a5c0ab37-a6d5-4cdc-9509-cd89723b9d89"}', '2026-10-07 19:12:52.468+09', '2026-10-07 19:12:52.468+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.473+09', NULL, NULL, '2026-10-07 19:12:52.468+09');
INSERT INTO public.outbox VALUES ('a24833cf-4950-4cf5-942e-dd73d250c164', 'tenant-c', 'extract', '{"observationId": "9ee72daa-0842-42d1-8d29-900b2aaa4afa"}', '2026-10-07 19:12:52.474+09', '2026-10-07 19:12:52.474+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.479+09', NULL, NULL, '2026-10-07 19:12:52.474+09');
INSERT INTO public.outbox VALUES ('ccc7c45f-0b13-4b17-ac80-bf426ccb36e4', 'tenant-c', 'extract', '{"observationId": "86b6d267-2ea3-4c07-9eeb-383030097f3d"}', '2026-10-07 19:12:52.481+09', '2026-10-07 19:12:52.481+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.485+09', NULL, NULL, '2026-10-07 19:12:52.481+09');
INSERT INTO public.outbox VALUES ('937b3d05-2220-4441-a389-7d12103fc49e', 'tenant-c', 'extract', '{"observationId": "656e297a-4352-420a-a704-0129ee2a0d2a"}', '2026-10-07 19:12:52.486+09', '2026-10-07 19:12:52.486+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.494+09', NULL, NULL, '2026-10-07 19:12:52.486+09');
INSERT INTO public.outbox VALUES ('b8aaa335-a2fd-403d-9945-d482a8d4d87d', 'tenant-c', 'extract', '{"observationId": "ea7ec8b5-b118-46e3-b0bf-07088df6b91d"}', '2026-10-07 19:12:52.495+09', '2026-10-07 19:12:52.495+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.5+09', NULL, NULL, '2026-10-07 19:12:52.495+09');
INSERT INTO public.outbox VALUES ('443b46e2-8014-4961-a3bd-7f33820aba94', 'tenant-c', 'extract', '{"observationId": "c1a01894-1ab7-4795-871e-b79b14f94dce"}', '2026-10-07 19:12:52.501+09', '2026-10-07 19:12:52.501+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.507+09', NULL, NULL, '2026-10-07 19:12:52.501+09');
INSERT INTO public.outbox VALUES ('411b52c7-a744-4d1f-9dfd-0bca376fc3e2', 'tenant-c', 'extract', '{"observationId": "846d54b0-52f3-4824-ac42-55d6bcd610a2"}', '2026-10-07 19:12:52.508+09', '2026-10-07 19:12:52.508+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.512+09', NULL, NULL, '2026-10-07 19:12:52.508+09');
INSERT INTO public.outbox VALUES ('00143d87-c7e8-4f8c-af57-215191b352e7', 'tenant-c', 'embed', '{"memoryId": "d53aa6f1-efc2-4133-84e8-c23c261072db"}', '2026-10-07 19:12:52.442+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, '2026-10-07 19:12:52.521+09', NULL, NULL, '2026-10-07 19:12:52.442+09');
INSERT INTO public.outbox VALUES ('557cf1d8-2426-4dd8-8a63-8de54beb2a56', 'tenant-c', 'embed', '{"memoryId": "43fba119-9a63-4595-bbea-66238cfe4009"}', '2026-10-07 19:12:52.45+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, '2026-10-07 19:12:52.526+09', NULL, NULL, '2026-10-07 19:12:52.45+09');
INSERT INTO public.outbox VALUES ('ab5dd299-8d83-43fb-af69-e5200af1219e', 'tenant-c', 'embed', '{"memoryId": "440644be-1a40-4a24-9e3a-999c8178bf4c"}', '2026-10-07 19:12:52.455+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, '2026-10-07 19:12:52.533+09', NULL, NULL, '2026-10-07 19:12:52.455+09');
INSERT INTO public.outbox VALUES ('e32a4f7a-4177-481a-bfcc-042408562cd8', 'tenant-c', 'embed', '{"memoryId": "89f0242f-7729-43bd-a2b3-b81acc754c6f"}', '2026-10-07 19:12:52.459+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, '2026-10-07 19:12:52.539+09', NULL, NULL, '2026-10-07 19:12:52.459+09');
INSERT INTO public.outbox VALUES ('8cce7a08-c693-4b27-8e40-6adb6384780a', 'tenant-c', 'embed', '{"memoryId": "3319bcd3-1742-44e9-bb42-ea02638343b0"}', '2026-10-07 19:12:52.465+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, '2026-10-07 19:12:52.544+09', NULL, NULL, '2026-10-07 19:12:52.465+09');
INSERT INTO public.outbox VALUES ('20d5e599-6e87-488f-8b45-5fc8ae86fdbb', 'tenant-c', 'embed', '{"memoryId": "e6054322-3049-4f0b-8cb0-0c0f1172aa02"}', '2026-10-07 19:12:52.471+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, '2026-10-07 19:12:52.548+09', NULL, NULL, '2026-10-07 19:12:52.471+09');
INSERT INTO public.outbox VALUES ('706511b5-f123-4687-bb77-345c2f49f511', 'tenant-c', 'embed', '{"memoryId": "f3821780-bee5-497a-b4be-a989bd6cbaf2"}', '2026-10-07 19:12:52.476+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, '2026-10-07 19:12:52.552+09', NULL, NULL, '2026-10-07 19:12:52.476+09');
INSERT INTO public.outbox VALUES ('5306d081-a885-4307-bc7e-7755d707cdf3', 'tenant-c', 'embed', '{"memoryId": "4b29392a-ff03-4202-acf2-ecc848c47351"}', '2026-10-07 19:12:52.483+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, '2026-10-07 19:12:52.555+09', NULL, NULL, '2026-10-07 19:12:52.483+09');
INSERT INTO public.outbox VALUES ('22f65f3d-daa5-462d-b468-0d004a24c1ef', 'tenant-c', 'embed', '{"memoryId": "16840f6c-70d7-4bcf-9177-47fa25a07288"}', '2026-10-07 19:12:52.49+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, '2026-10-07 19:12:52.558+09', NULL, NULL, '2026-10-07 19:12:52.49+09');
INSERT INTO public.outbox VALUES ('627f7913-ec78-4215-a019-f7a858e539e3', 'tenant-c', 'embed', '{"memoryId": "19c872f6-8d04-4472-ba15-67cd823bf126"}', '2026-10-07 19:12:52.497+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, '2026-10-07 19:12:52.56+09', NULL, NULL, '2026-10-07 19:12:52.497+09');
INSERT INTO public.outbox VALUES ('76b7dd76-be74-4c7b-ba0c-a2f44b2ea0b4', 'tenant-c', 'embed', '{"memoryId": "16b8bf3e-0449-491c-bc31-68cf473dd039"}', '2026-10-07 19:12:52.503+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, '2026-10-07 19:12:52.564+09', NULL, NULL, '2026-10-07 19:12:52.503+09');
INSERT INTO public.outbox VALUES ('4f939fb1-e536-41a5-ae6f-6848a6fa5b65', 'tenant-c', 'embed', '{"memoryId": "a2a3e4af-738a-4558-b1a2-d698be696c1e"}', '2026-10-07 19:12:52.51+09', '2026-10-07 19:12:52.513+09', 'runtime.tick', 1, NULL, '2026-10-07 19:12:52.568+09', 'fixture: embedding provider failure', '2026-10-07 19:12:52.51+09');
INSERT INTO public.outbox VALUES ('9b5bd185-7eb0-4717-8adc-67c119d2c7e2', 'tenant-c', 'embed', '{"memoryId": "a50807a2-1ed9-4501-96e5-791784019580"}', '2026-10-07 19:12:52.572+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:52.572+09');
INSERT INTO public.outbox VALUES ('994ab6c9-2483-4a92-b65c-2389f0ee4bfb', 'tenant-c', 'extract', '{"observationId": "1f78d7a5-2198-4466-94b5-585c307a7e04"}', '2026-10-07 19:12:52.569+09', '2026-10-07 19:12:52.569+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.576+09', NULL, NULL, '2026-10-07 19:12:52.569+09');
INSERT INTO public.outbox VALUES ('05dde65c-19d2-4610-8352-8570462ca942', 'tenant-c', 'embed', '{"memoryId": "c3e02248-0c52-4df5-bd10-9966495a7261"}', '2026-10-07 19:12:52.579+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:52.579+09');
INSERT INTO public.outbox VALUES ('95b8fd79-44aa-456f-8bfd-bc7a0e2096c0', 'tenant-c', 'extract', '{"observationId": "845b6702-0924-4210-8f55-316cc5de1f13"}', '2026-10-07 19:12:52.577+09', '2026-10-07 19:12:52.577+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.582+09', NULL, NULL, '2026-10-07 19:12:52.577+09');
INSERT INTO public.outbox VALUES ('bd67b3b5-ad3c-48ca-be14-06f790d841aa', 'tenant-c', 'embed', '{"memoryId": "12496de4-aa92-4616-81e9-f8eab2f262f2"}', '2026-10-07 19:12:52.585+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:52.585+09');
INSERT INTO public.outbox VALUES ('55829af6-477d-4839-b4ed-b462826d29fd', 'tenant-c', 'extract', '{"observationId": "c6f74baa-6572-455d-ae7c-10be1cbeb8a2"}', '2026-10-07 19:12:52.583+09', '2026-10-07 19:12:52.583+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.588+09', NULL, NULL, '2026-10-07 19:12:52.583+09');
INSERT INTO public.outbox VALUES ('f16766aa-4e0a-4c13-9a87-d8194f0583ee', 'tenant-a2', 'extract', '{"observationId": "2d51a829-15a5-48f3-a788-08388c8107be"}', '2026-10-07 19:12:52.644+09', '2026-10-07 19:12:52.644+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.65+09', NULL, NULL, '2026-10-07 19:12:52.644+09');
INSERT INTO public.outbox VALUES ('f89312cf-f82e-4a0d-89e9-1d26bb8162c6', 'tenant-a2', 'extract', '{"observationId": "1a0649c2-d851-452a-9045-37f8d86d0e03"}', '2026-10-07 19:12:52.651+09', '2026-10-07 19:12:52.651+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.657+09', NULL, NULL, '2026-10-07 19:12:52.651+09');
INSERT INTO public.outbox VALUES ('92ff16de-ffcf-496a-a9c9-1f3263fd46da', 'tenant-a2', 'extract', '{"observationId": "d2af2469-a243-41da-8ce3-95a21b50e1db"}', '2026-10-07 19:12:52.657+09', '2026-10-07 19:12:52.657+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.664+09', NULL, NULL, '2026-10-07 19:12:52.657+09');
INSERT INTO public.outbox VALUES ('ee1e56d7-22ad-4471-b146-5a5261ce825a', 'tenant-a2', 'extract', '{"observationId": "fb4be86a-992d-4c6e-9d6d-9e925bd6f5e2"}', '2026-10-07 19:12:52.665+09', '2026-10-07 19:12:52.665+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.671+09', NULL, NULL, '2026-10-07 19:12:52.665+09');
INSERT INTO public.outbox VALUES ('d6c826a0-ad17-4964-82c8-2a0db06bca1d', 'tenant-a2', 'extract', '{"observationId": "2100c358-6b7f-48bf-9f35-993271b9f5bf"}', '2026-10-07 19:12:52.672+09', '2026-10-07 19:12:52.672+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.677+09', NULL, NULL, '2026-10-07 19:12:52.672+09');
INSERT INTO public.outbox VALUES ('4dc0d886-177c-4554-aeb0-6cc09248ebb1', 'tenant-a2', 'extract', '{"observationId": "6f3ebc30-c6cd-426b-a880-73d77d098e3f"}', '2026-10-07 19:12:52.678+09', '2026-10-07 19:12:52.678+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.683+09', NULL, NULL, '2026-10-07 19:12:52.678+09');
INSERT INTO public.outbox VALUES ('fd5c1073-2c93-4011-8807-f0ac861ed332', 'tenant-a2', 'extract', '{"observationId": "70c5dcc4-2b10-4fd1-bb01-d0c2e2a4e509"}', '2026-10-07 19:12:52.684+09', '2026-10-07 19:12:52.684+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.689+09', NULL, NULL, '2026-10-07 19:12:52.684+09');
INSERT INTO public.outbox VALUES ('465b9887-0f06-499f-93e9-903336e3f1a7', 'tenant-a2', 'embed', '{"memoryId": "00f84f24-e729-4fbe-bd5d-4e50ae927069"}', '2026-10-07 19:12:52.647+09', '2026-10-07 19:12:52.717+09', 'runtime.tick', 1, '2026-10-07 19:12:52.72+09', NULL, NULL, '2026-10-07 19:12:52.647+09');
INSERT INTO public.outbox VALUES ('135911fc-1605-4225-949f-f0d475079658', 'tenant-a2', 'extract', '{"observationId": "a0ec89f0-437b-4f8b-a6a3-d33c994d9188"}', '2026-10-07 19:12:52.689+09', '2026-10-07 19:12:52.689+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.695+09', NULL, NULL, '2026-10-07 19:12:52.689+09');
INSERT INTO public.outbox VALUES ('35c91e0f-c71a-445a-b630-c4e3ed337779', 'tenant-a2', 'extract', '{"observationId": "5aeaf542-a623-411e-ab60-9d8d3eec836d"}', '2026-10-07 19:12:52.696+09', '2026-10-07 19:12:52.696+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.702+09', NULL, NULL, '2026-10-07 19:12:52.696+09');
INSERT INTO public.outbox VALUES ('0e0747e5-86f3-4727-9af9-9496586e66db', 'tenant-a2', 'extract', '{"observationId": "e25c1728-d32d-434e-8f9f-da0740f96989"}', '2026-10-07 19:12:52.703+09', '2026-10-07 19:12:52.703+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.71+09', NULL, NULL, '2026-10-07 19:12:52.703+09');
INSERT INTO public.outbox VALUES ('2cc7f3bb-34b7-4a8f-981a-86a4e22ad0d8', 'tenant-a2', 'extract', '{"observationId": "5938f6cb-a78d-4810-a547-db58a810d2e2"}', '2026-10-07 19:12:52.711+09', '2026-10-07 19:12:52.711+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.716+09', NULL, NULL, '2026-10-07 19:12:52.711+09');
INSERT INTO public.outbox VALUES ('2a6c9a2a-f60c-4789-8d8b-f6f7e8ee6359', 'tenant-a2', 'embed', '{"memoryId": "6e16eb94-cbcd-428d-a869-b165aa923156"}', '2026-10-07 19:12:52.654+09', '2026-10-07 19:12:52.717+09', 'runtime.tick', 1, '2026-10-07 19:12:52.723+09', NULL, NULL, '2026-10-07 19:12:52.654+09');
INSERT INTO public.outbox VALUES ('8dab26ad-238e-4194-8731-e121a4cccacb', 'tenant-a2', 'embed', '{"memoryId": "c3565db1-1d89-4840-92a4-72202a1d7d1b"}', '2026-10-07 19:12:52.66+09', '2026-10-07 19:12:52.717+09', 'runtime.tick', 1, '2026-10-07 19:12:52.729+09', NULL, NULL, '2026-10-07 19:12:52.66+09');
INSERT INTO public.outbox VALUES ('7f96df03-bd78-4ef9-a467-8e28ba2a97a9', 'tenant-a2', 'embed', '{"memoryId": "b7700129-cc17-42c1-a253-0d880251b449"}', '2026-10-07 19:12:52.668+09', '2026-10-07 19:12:52.717+09', 'runtime.tick', 1, '2026-10-07 19:12:52.735+09', NULL, NULL, '2026-10-07 19:12:52.668+09');
INSERT INTO public.outbox VALUES ('6202aa9c-6900-400a-96fa-a92b05afc0db', 'tenant-a2', 'embed', '{"memoryId": "508d83d2-b520-4776-803d-b9a1c7096ae7"}', '2026-10-07 19:12:52.674+09', '2026-10-07 19:12:52.717+09', 'runtime.tick', 1, '2026-10-07 19:12:52.741+09', NULL, NULL, '2026-10-07 19:12:52.674+09');
INSERT INTO public.outbox VALUES ('1803ff44-1373-49c0-beff-714ce3e831e4', 'tenant-a2', 'embed', '{"memoryId": "4cf3b6a3-60dd-4c10-b99e-05a49df3085b"}', '2026-10-07 19:12:52.68+09', '2026-10-07 19:12:52.717+09', 'runtime.tick', 1, '2026-10-07 19:12:52.746+09', NULL, NULL, '2026-10-07 19:12:52.68+09');
INSERT INTO public.outbox VALUES ('2b3d7df0-2097-426d-b9f0-22bce63e103d', 'tenant-a2', 'embed', '{"memoryId": "f8f00d0e-6f75-4543-97da-10cb06d60fa3"}', '2026-10-07 19:12:52.686+09', '2026-10-07 19:12:52.717+09', 'runtime.tick', 1, '2026-10-07 19:12:52.749+09', NULL, NULL, '2026-10-07 19:12:52.686+09');
INSERT INTO public.outbox VALUES ('7ee863df-b615-46ec-a693-c320f2c55daf', 'tenant-a2', 'embed', '{"memoryId": "c9a89bc9-4f95-4a16-bab3-0ac9b2ce3a6a"}', '2026-10-07 19:12:52.691+09', '2026-10-07 19:12:52.717+09', 'runtime.tick', 1, '2026-10-07 19:12:52.753+09', NULL, NULL, '2026-10-07 19:12:52.691+09');
INSERT INTO public.outbox VALUES ('eba733a1-aaf3-450e-b697-d570bd7aa53c', 'tenant-a2', 'embed', '{"memoryId": "bfcdc3db-c2d6-4bda-b13f-0e3d66efc308"}', '2026-10-07 19:12:52.699+09', '2026-10-07 19:12:52.717+09', 'runtime.tick', 1, '2026-10-07 19:12:52.757+09', NULL, NULL, '2026-10-07 19:12:52.699+09');
INSERT INTO public.outbox VALUES ('1748b0c9-9f08-4db6-b645-459ace9612a3', 'tenant-a2', 'embed', '{"memoryId": "54ed5ae5-101a-44f5-bb90-82d65a7d5c4a"}', '2026-10-07 19:12:52.706+09', '2026-10-07 19:12:52.717+09', 'runtime.tick', 1, '2026-10-07 19:12:52.764+09', NULL, NULL, '2026-10-07 19:12:52.706+09');
INSERT INTO public.outbox VALUES ('d7921e98-01d3-4271-a5d0-65a21956c110', 'tenant-a2', 'embed', '{"memoryId": "afb827c4-1fdd-4108-a182-2064b7042e38"}', '2026-10-07 19:12:52.713+09', '2026-10-07 19:12:52.717+09', 'runtime.tick', 1, NULL, '2026-10-07 19:12:52.768+09', 'fixture: embedding provider failure', '2026-10-07 19:12:52.713+09');
INSERT INTO public.outbox VALUES ('3e8bc647-d9a2-43bf-883f-57f437cc3d19', 'tenant-a2', 'embed', '{"memoryId": "8de058cd-3b91-4ba2-8124-eb6eba86559f"}', '2026-10-07 19:12:52.772+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:52.772+09');
INSERT INTO public.outbox VALUES ('edfb02ca-fded-4c78-8aee-e6164d719fc4', 'tenant-a2', 'extract', '{"observationId": "6758aa96-3ea1-4016-b661-4c897dd55bb4"}', '2026-10-07 19:12:52.769+09', '2026-10-07 19:12:52.769+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.776+09', NULL, NULL, '2026-10-07 19:12:52.769+09');
INSERT INTO public.outbox VALUES ('773c0c3f-f37f-49bc-be6f-d3ba3c416b4e', 'tenant-a2', 'embed', '{"memoryId": "5bff9eb5-314a-4147-8d00-5cfefe9c39f4"}', '2026-10-07 19:12:52.78+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:52.78+09');
INSERT INTO public.outbox VALUES ('974e896e-7279-4c8d-a07e-9511daa43dc2', 'tenant-a2', 'extract', '{"observationId": "6b0f0d6d-3559-4834-a174-43d30fce1e9c"}', '2026-10-07 19:12:52.777+09', '2026-10-07 19:12:52.777+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.782+09', NULL, NULL, '2026-10-07 19:12:52.777+09');
INSERT INTO public.outbox VALUES ('34233e7f-bf71-455d-91ad-390e6481983b', 'tenant-a2', 'embed', '{"memoryId": "006af83c-df70-4a57-a587-ba1e246ecd6d"}', '2026-10-07 19:12:52.784+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:52.784+09');
INSERT INTO public.outbox VALUES ('5bfaf79e-e902-4f7b-bef4-bbb3b284a412', 'tenant-a2', 'extract', '{"observationId": "64d6558e-677f-4f5a-b6b9-3376bfcaf3d4"}', '2026-10-07 19:12:52.783+09', '2026-10-07 19:12:52.783+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:52.787+09', NULL, NULL, '2026-10-07 19:12:52.783+09');


--
-- Data for Name: recall_usages; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.recall_usages VALUES ('tenant-a', '458643c3-ee4f-410f-b5a7-8aefa8a2448c', '400a62ea-1ab6-4d34-88dc-45c27c4bf60e', '2026-10-07 19:12:52.060731+09');
INSERT INTO public.recall_usages VALUES ('tenant-b', '37260f26-e0d1-48f0-91f0-1304b831c3ce', '54c374fa-f7b3-4db5-9a5c-4c8de3385bc7', '2026-10-07 19:12:52.428152+09');
INSERT INTO public.recall_usages VALUES ('tenant-c', '54c0b0ba-89ba-45dd-9823-52d0cae57b5b', '43fba119-9a63-4595-bbea-66238cfe4009', '2026-10-07 19:12:52.639894+09');
INSERT INTO public.recall_usages VALUES ('tenant-a2', 'd2feea5e-f297-46ca-a3f0-e69655a2f618', 'c3565db1-1d89-4840-92a4-72202a1d7d1b', '2026-10-07 19:12:52.821484+09');


--
-- Data for Name: recalls; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.recalls VALUES ('458643c3-ee4f-410f-b5a7-8aefa8a2448c', 'tenant-a', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 2, "countKind": "exact"}, {"kind": "ann_truncated", "certainty": "undecidable", "countKind": "unknown", "undecidableReason": "ANN が返した最後の similarity が 0 以下または非有限である（NaN）。この場合、上界の不等式は total の順序を保証しない。"}, {"kind": "over_limit", "count": 2, "stage": "association", "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 2, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 1357, "byTier": {"full": 0, "index": 898, "digest": 459, "association": 286}, "counter": "heuristic", "indexChars": 898, "estimatedTokens": 527}', '{"groups": [{"key": null, "axis": "subject", "count": 24, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-a 未埋め込み 2", "memoryId": "74bb4b4c-9f10-453b-83a5-7c751a5e6634"}, {"digest": "tenant-a 未埋め込み 1", "memoryId": "8bbf52e0-3f71-4492-a289-0cc9c0d21309"}, {"digest": "tenant-a 未埋め込み 0", "memoryId": "09e42cf5-58dd-496c-8f0e-ca2db70fea87"}, {"digest": "tenant-a FAIL 埋め込み失敗 東京", "memoryId": "b02b0fa2-fa68-4505-a998-efe8ac11f6d0"}, {"digest": "tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO", "memoryId": "b7adc42b-6c36-489a-abd9-318425688272"}, {"digest": "tenant-a の記憶 7 東京 会議 プロジェクト2", "memoryId": "fcd8b5e4-3c5e-41ea-bbaa-0817d76d824c"}, {"digest": "tenant-a の記憶 5 東京 会議 プロジェクト0", "memoryId": "58ec7654-8f38-4c2e-adb6-309bccf32956"}, {"digest": "tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "b0ebb353-77af-487e-bc5e-644be85d3c7a"}], "totalInScope": 24, "digestBandCoverage": {"shown": 8, "eligible": 8, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-10-07T10:12:52.027Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 20, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 20, "withinLimit": 5, "notComparable": 2, "passedThreshold": 18}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 0}, "executed": true}, {"stage": "association", "detail": {"hits": 13, "anchors": 3, "selected": 10}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 15, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 24}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-10-07 19:12:52.027+09', '{"memories": [{"score": {"decay": 0.99999994812093, "total": 0.7063611341574697, "strength": 1, "tagMatch": 1, "freshness": 0.99999994812093, "similarity": 0.7063612074481929, "affinityMeasured": true}, "memoryId": "400a62ea-1ab6-4d34-88dc-45c27c4bf60e", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999494580194, "total": 0.7058284817454819, "strength": 1, "tagMatch": 1, "freshness": 0.9999999494580194, "similarity": 0.7058285530934261, "affinityMeasured": true}, "memoryId": "09d4c803-84ed-45fb-8cd9-2342917e0943", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999409006473, "total": 0.7057909973852159, "strength": 1, "tagMatch": 1, "freshness": 0.9999999409006473, "similarity": 0.7057910808088055, "affinityMeasured": true}, "memoryId": "ae8e9716-84e9-47f3-a501-596a9b524ff5", "retrievedVia": "ann"}, {"score": {"decay": 0.999999935017454, "total": 0.705645348511236, "strength": 1, "tagMatch": 1, "freshness": 0.999999935017454, "similarity": 0.7056454402205076, "affinityMeasured": true}, "memoryId": "c8a9eeb5-ed23-4c73-9df3-a30482aa550f", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999507951087, "total": 0.7052962181088187, "strength": 1, "tagMatch": 1, "freshness": 0.9999999507951087, "similarity": 0.7052962875168712, "affinityMeasured": true}, "memoryId": "60a9be4a-b274-481d-a7fa-1beef08a824c", "retrievedVia": "ann"}, {"score": {"decay": 0.999999936889379, "strength": 1, "tagMatch": 1, "freshness": 0.999999936889379, "affinityMeasured": false}, "memoryId": "1f155584-eb38-4b19-a539-45252c8b2d02", "retrievedVia": "association", "associationOf": "400a62ea-1ab6-4d34-88dc-45c27c4bf60e"}, {"score": {"decay": 0.9999999526670339, "strength": 1, "tagMatch": 1, "freshness": 0.9999999526670339, "affinityMeasured": false}, "memoryId": "464e8b6a-e223-4946-ab92-c30c8c7d6d0c", "retrievedVia": "association", "associationOf": "400a62ea-1ab6-4d34-88dc-45c27c4bf60e"}, {"score": {"decay": 0.9999999384938864, "strength": 1, "tagMatch": 1, "freshness": 0.9999999384938864, "affinityMeasured": false}, "memoryId": "66a39a9a-cee2-4d2a-83d1-e74a795f2069", "retrievedVia": "association", "associationOf": "400a62ea-1ab6-4d34-88dc-45c27c4bf60e"}, {"score": {"decay": 0.9999999425051544, "strength": 1, "tagMatch": 1, "freshness": 0.9999999425051544, "affinityMeasured": false}, "memoryId": "a877a726-3af7-4c82-9e2e-074cd07ab8cb", "retrievedVia": "association", "associationOf": "400a62ea-1ab6-4d34-88dc-45c27c4bf60e"}, {"score": {"decay": 0.9999999451793333, "strength": 1, "tagMatch": 1, "freshness": 0.9999999451793333, "affinityMeasured": false}, "memoryId": "f164a835-0ac4-48e1-a09d-4e2b161b1ce1", "retrievedVia": "association", "associationOf": "400a62ea-1ab6-4d34-88dc-45c27c4bf60e"}, {"score": {"decay": 0.9999999467838405, "strength": 1, "tagMatch": 1, "freshness": 0.9999999467838405, "affinityMeasured": false}, "memoryId": "a800507b-204e-4829-9160-ebd0e307c892", "retrievedVia": "association", "associationOf": "400a62ea-1ab6-4d34-88dc-45c27c4bf60e"}, {"score": {"decay": 0.9999999149611134, "strength": 1, "tagMatch": 1, "freshness": 0.9999999149611134, "affinityMeasured": false}, "memoryId": "9e5e0ceb-69d0-4469-9673-6d333ffe6575", "retrievedVia": "association", "associationOf": "400a62ea-1ab6-4d34-88dc-45c27c4bf60e"}, {"score": {"decay": 0.9999999130891883, "strength": 1, "tagMatch": 1, "freshness": 0.9999999130891883, "affinityMeasured": false}, "memoryId": "7758338c-58cb-4fc7-8bbe-1392d468e32c", "retrievedVia": "association", "associationOf": "400a62ea-1ab6-4d34-88dc-45c27c4bf60e"}, {"score": {"decay": 0.9999999090779202, "strength": 1, "tagMatch": 1, "freshness": 0.9999999090779202, "affinityMeasured": false}, "memoryId": "2fbb63f9-0722-4677-bab2-8d3b7533f9f8", "retrievedVia": "association", "associationOf": "400a62ea-1ab6-4d34-88dc-45c27c4bf60e"}, {"score": {"decay": 0.9999999269949177, "strength": 1, "tagMatch": 1, "freshness": 0.9999999269949177, "affinityMeasured": false}, "memoryId": "3aad2359-9ce5-47d3-8499-3d122b931d75", "retrievedVia": "association", "associationOf": "400a62ea-1ab6-4d34-88dc-45c27c4bf60e"}, {"score": {"decay": 0.9999999227162317, "strength": 1, "tagMatch": 1, "freshness": 0.9999999227162317, "affinityMeasured": false}, "memoryId": "01767b15-4fd2-438b-86d7-ac0312ea6421", "companionOf": "3aad2359-9ce5-47d3-8499-3d122b931d75", "retrievedVia": "mandatory_companion"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('37260f26-e0d1-48f0-91f0-1304b831c3ce', 'tenant-b', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 2, "countKind": "exact"}, {"kind": "unit_assembly_dropped", "count": 1, "countKind": "lower_bound"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 3, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 1091, "byTier": {"full": 0, "index": 806, "digest": 285, "association": 140}, "counter": "heuristic", "indexChars": 806, "estimatedTokens": 400}', '{"groups": [{"key": null, "axis": "subject", "count": 17, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-b 未埋め込み 2", "memoryId": "4c8e161d-6af2-442c-8c6f-35239c511284"}, {"digest": "tenant-b 未埋め込み 1", "memoryId": "4ab8047e-cd2d-4c71-8c8d-1cfe2e0acd2a"}, {"digest": "tenant-b 未埋め込み 0", "memoryId": "1dc03000-9b4f-465d-86da-c76b90217646"}, {"digest": "tenant-b FAIL 埋め込み失敗 東京", "memoryId": "76c5a046-8a29-4efa-8313-0798f4f706ae"}, {"digest": "tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO", "memoryId": "58cc3a78-bdc4-4f49-80b0-c4b5bf0446ab"}, {"digest": "tenant-b の記憶 6 東京 会議 プロジェクト1", "memoryId": "2345525e-c383-4053-9786-b90220bda018"}, {"digest": "tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "99ef7e87-2791-47f2-aa14-3dda1f2986d3"}], "totalInScope": 17, "digestBandCoverage": {"shown": 7, "eligible": 7, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-10-07T10:12:52.412Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 13, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 13, "withinLimit": 5, "notComparable": 2, "passedThreshold": 11}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 0}, "executed": true}, {"stage": "association", "detail": {"hits": 6, "anchors": 3, "selected": 6}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 10, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 17}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-10-07 19:12:52.412+09', '{"memories": [{"score": {"decay": 0.9999999606895704, "total": 0.6564809901473738, "strength": 1, "tagMatch": 1, "freshness": 0.9999999606895704, "similarity": 0.6564810417604764, "affinityMeasured": true}, "memoryId": "54c374fa-f7b3-4db5-9a5c-4c8de3385bc7", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999590850631, "total": 0.6564712198855488, "strength": 1, "tagMatch": 1, "freshness": 0.9999999590850631, "similarity": 0.6564712736045092, "affinityMeasured": true}, "memoryId": "07758de0-0b13-4eb4-8130-3d24ce222d05", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999561434664, "total": 0.6564612090414571, "strength": 1, "tagMatch": 1, "freshness": 0.9999999561434664, "similarity": 0.6564612666216871, "affinityMeasured": true}, "memoryId": "3757a0f2-1d20-4ed8-96d6-cea64cf1e1b0", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999647008386, "total": 0.6554165722330527, "strength": 1, "tagMatch": 1, "freshness": 0.9999999647008386, "similarity": 0.6554166185043658, "affinityMeasured": true}, "memoryId": "d917c811-ee4e-47ba-b95e-eeb1af32515f", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999625614956, "total": 0.6554060556473975, "strength": 1, "tagMatch": 1, "freshness": 0.9999999625614956, "similarity": 0.6554061047222453, "affinityMeasured": true}, "memoryId": "8a9121da-4b25-476e-bdf0-dda5f7b43ce3", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999090779202, "strength": 1, "tagMatch": 1, "freshness": 0.9999999090779202, "affinityMeasured": false}, "memoryId": "c10b7458-aef5-4886-a8e4-f339ab991e81", "retrievedVia": "association", "associationOf": "54c374fa-f7b3-4db5-9a5c-4c8de3385bc7"}, {"score": {"decay": 0.9999999106824274, "strength": 1, "tagMatch": 1, "freshness": 0.9999999106824274, "affinityMeasured": false}, "memoryId": "f7e7c94a-0411-49ec-9dbe-12585c3ddf78", "retrievedVia": "association", "associationOf": "54c374fa-f7b3-4db5-9a5c-4c8de3385bc7"}, {"score": {"decay": 0.9999999122869347, "strength": 1, "tagMatch": 1, "freshness": 0.9999999122869347, "affinityMeasured": false}, "memoryId": "528b2953-538b-46e9-bb90-7d2962241368", "retrievedVia": "association", "associationOf": "54c374fa-f7b3-4db5-9a5c-4c8de3385bc7"}, {"score": {"decay": 0.9999999184375458, "strength": 1, "tagMatch": 1, "freshness": 0.9999999184375458, "affinityMeasured": false}, "memoryId": "3162294f-c08c-40e0-a234-4bcf93cda901", "retrievedVia": "association", "associationOf": "54c374fa-f7b3-4db5-9a5c-4c8de3385bc7"}, {"score": {"decay": 0.999999922181396, "strength": 1, "tagMatch": 1, "freshness": 0.999999922181396, "affinityMeasured": false}, "memoryId": "d5a955fb-8a2d-4724-8ce8-5ea29765ddf4", "retrievedVia": "association", "associationOf": "54c374fa-f7b3-4db5-9a5c-4c8de3385bc7"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('54c0b0ba-89ba-45dd-9823-52d0cae57b5b', 'tenant-c', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 1, "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 3, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 784, "byTier": {"full": 0, "index": 616, "digest": 168, "association": 0}, "counter": "heuristic", "indexChars": 616, "estimatedTokens": 272}', '{"groups": [{"key": null, "axis": "subject", "count": 11, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-c 未埋め込み 2", "memoryId": "12496de4-aa92-4616-81e9-f8eab2f262f2"}, {"digest": "tenant-c 未埋め込み 1", "memoryId": "c3e02248-0c52-4df5-bd10-9966495a7261"}, {"digest": "tenant-c 未埋め込み 0", "memoryId": "a50807a2-1ed9-4501-96e5-791784019580"}, {"digest": "tenant-c FAIL 埋め込み失敗 東京", "memoryId": "a2a3e4af-738a-4558-b1a2-d698be696c1e"}, {"digest": "tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "440644be-1a40-4a24-9e3a-999c8178bf4c"}], "totalInScope": 11, "digestBandCoverage": {"shown": 5, "eligible": 5, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-10-07T10:12:52.619Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 7, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 7, "withinLimit": 5, "notComparable": 1, "passedThreshold": 6}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 1}, "executed": true}, {"stage": "association", "detail": {"hits": 0, "anchors": 3, "selected": 0}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 5, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 11}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-10-07 19:12:52.619+09', '{"memories": [{"score": {"decay": 0.9999999548063769, "total": 0.5446698953466218, "strength": 1, "tagMatch": 1, "freshness": 0.9999999548063769, "similarity": 0.5446699445778371, "affinityMeasured": true}, "memoryId": "43fba119-9a63-4595-bbea-66238cfe4009", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999526670339, "total": 0.5442745417091901, "strength": 1, "tagMatch": 1, "freshness": 0.9999999526670339, "similarity": 0.5442745932334506, "affinityMeasured": true}, "memoryId": "d53aa6f1-efc2-4133-84e8-c23c261072db", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999636311672, "total": 0.5442010781891957, "strength": 1, "tagMatch": 1, "freshness": 0.9999999636311672, "similarity": 0.544201117773114, "affinityMeasured": true}, "memoryId": "4b29392a-ff03-4202-acf2-ecc848c47351", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999601547346, "strength": 1, "tagMatch": 1, "freshness": 0.9999999601547346, "affinityMeasured": false}, "memoryId": "e6054322-3049-4f0b-8cb0-0c0f1172aa02", "companionOf": "4b29392a-ff03-4202-acf2-ecc848c47351", "retrievedVia": "mandatory_companion"}, {"score": {"decay": 0.9999999505276909, "total": 0.5438775532329655, "strength": 1, "tagMatch": 1, "freshness": 0.9999999505276909, "similarity": 0.5438776070467263, "affinityMeasured": true}, "memoryId": "acf6281f-843b-4c01-be93-d6f4a2a1be04", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999617592419, "total": 0.5438076433295211, "strength": 1, "tagMatch": 1, "freshness": 0.9999999617592419, "similarity": 0.5438076849207566, "affinityMeasured": true}, "memoryId": "f3821780-bee5-497a-b4be-a989bd6cbaf2", "retrievedVia": "ann"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('d2feea5e-f297-46ca-a3f0-e69655a2f618', 'tenant-a2', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 1, "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 2, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 662, "byTier": {"full": 0, "index": 459, "digest": 203, "association": 29}, "counter": "heuristic", "indexChars": 459, "estimatedTokens": 244}', '{"groups": [{"key": null, "axis": "subject", "count": 10, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-a2 未埋め込み 2", "memoryId": "006af83c-df70-4a57-a587-ba1e246ecd6d"}, {"digest": "tenant-a2 FAIL 埋め込み失敗 東京", "memoryId": "afb827c4-1fdd-4108-a182-2064b7042e38"}, {"digest": "tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "b7700129-cc17-42c1-a253-0d880251b449"}], "totalInScope": 10, "digestBandCoverage": {"shown": 3, "eligible": 3, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-10-07T10:12:52.807Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 8, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 8, "withinLimit": 5, "notComparable": 1, "passedThreshold": 7}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 1}, "executed": true}, {"stage": "association", "detail": {"hits": 1, "anchors": 3, "selected": 1}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 6, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 10}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-10-07 19:12:52.807+09', '{"memories": [{"score": {"decay": 0.9999999606895704, "total": 0.3296480605342147, "strength": 1, "tagMatch": 1, "freshness": 0.9999999606895704, "similarity": 0.32964808645142996, "affinityMeasured": true}, "memoryId": "c3565db1-1d89-4840-92a4-72202a1d7d1b", "retrievedVia": "ann"}, {"score": {"decay": 0.99999997085145, "total": 0.329512517200984, "strength": 1, "tagMatch": 1, "freshness": 0.99999997085145, "similarity": 0.32951253641060907, "affinityMeasured": true}, "memoryId": "bfcdc3db-c2d6-4bda-b13f-0e3d66efc308", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999676424354, "strength": 1, "tagMatch": 1, "freshness": 0.9999999676424354, "affinityMeasured": false}, "memoryId": "f8f00d0e-6f75-4543-97da-10cb06d60fa3", "companionOf": "bfcdc3db-c2d6-4bda-b13f-0e3d66efc308", "retrievedVia": "mandatory_companion"}, {"score": {"decay": 0.9999999588176453, "total": 0.3292026241567647, "strength": 1, "tagMatch": 1, "freshness": 0.9999999588176453, "similarity": 0.3292026512714449, "affinityMeasured": true}, "memoryId": "6e16eb94-cbcd-428d-a869-b165aa923156", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999689795248, "total": 0.32906898567585396, "strength": 1, "tagMatch": 1, "freshness": 0.9999999689795248, "similarity": 0.3290690060916075, "affinityMeasured": true}, "memoryId": "c9a89bc9-4f95-4a16-bab3-0ac9b2ce3a6a", "retrievedVia": "ann"}, {"score": {"decay": 0.999999957213138, "total": 0.328756532447017, "strength": 1, "tagMatch": 1, "freshness": 0.999999957213138, "similarity": 0.3287565605799396, "affinityMeasured": true}, "memoryId": "00f84f24-e729-4fbe-bd5d-4e50ae927069", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999660379281, "strength": 1, "tagMatch": 1, "freshness": 0.9999999660379281, "affinityMeasured": false}, "memoryId": "4cf3b6a3-60dd-4c10-b99e-05a49df3085b", "retrievedVia": "association", "associationOf": "c3565db1-1d89-4840-92a4-72202a1d7d1b"}], "breakdownCaptured": true}');


--
-- Data for Name: tenant_activity; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: tenant_settings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: tenant_subject_activity; Type: TABLE DATA; Schema: public; Owner: -
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
-- Name: memory_relations memory_relations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_relations
    ADD CONSTRAINT memory_relations_pkey PRIMARY KEY (id);


--
-- Name: memory_relations memory_relations_tenant_id_from_memory_id_to_memory_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_relations
    ADD CONSTRAINT memory_relations_tenant_id_from_memory_id_to_memory_id_kind_key UNIQUE (tenant_id, from_memory_id, to_memory_id, kind);


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
-- Name: tenant_subject_activity tenant_subject_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_subject_activity
    ADD CONSTRAINT tenant_subject_activity_pkey PRIMARY KEY (tenant_id, subject_id);


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
-- Name: idx_memories_claim_predicates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_claim_predicates ON public.memories USING btree (tenant_id, subject_id, claim_key_predicate, created_at) WHERE ((status = 'active'::text) AND (claim_key_subject IS NOT NULL) AND (claim_key_predicate IS NOT NULL));


--
-- Name: idx_memories_contested; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_contested ON public.memories USING btree (tenant_id, status) WHERE (status = 'contested'::text);


--
-- Name: idx_memories_contested_with; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_contested_with ON public.memories USING btree (contested_with_id) WHERE (contested_with_id IS NOT NULL);


--
-- Name: idx_memories_digest_band; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_digest_band ON public.memories USING btree (tenant_id, COALESCE(occurred_at, recorded_at) DESC, id DESC) WHERE (status = ANY (ARRAY['active'::text, 'contested'::text]));


--
-- Name: idx_memories_lexical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_lexical ON public.memories USING gin (tenant_id, public.mnemora_lexical_tsvector(content)) WHERE (status = ANY (ARRAY['active'::text, 'contested'::text]));


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
-- Name: idx_memories_source_observation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_source_observation_id ON public.memories USING btree (source_observation_id);


--
-- Name: idx_memories_superseded_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_superseded_by ON public.memories USING btree (tenant_id, superseded_by_id) WHERE (superseded_by_id IS NOT NULL);


--
-- Name: idx_memories_superseded_by_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_superseded_by_id ON public.memories USING btree (superseded_by_id);


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
-- Name: idx_memory_embeddings_memory_id_some_very_long_provide_0428309b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_memory_id_some_very_long_provide_0428309b ON public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 USING btree (memory_id);


--
-- Name: idx_memory_embeddings_memory_id_test_fixture_model_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_memory_id_test_fixture_model_3 ON public.memory_embeddings_test_fixture_model_3 USING btree (memory_id);


--
-- Name: idx_memory_embeddings_memory_id_testkit_deterministic_8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_memory_id_testkit_deterministic_8 ON public.memory_embeddings_testkit_deterministic_8 USING btree (memory_id);


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
-- Name: idx_memory_events_memory_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_memory_id ON public.memory_events USING btree (memory_id);


--
-- Name: idx_memory_labels_by_label; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_labels_by_label ON public.memory_labels USING btree (tenant_id, label_id);


--
-- Name: idx_memory_labels_label_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_labels_label_id ON public.memory_labels USING btree (label_id);


--
-- Name: idx_memory_labels_memory_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_labels_memory_id ON public.memory_labels USING btree (memory_id);


--
-- Name: idx_memory_relations_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_relations_from ON public.memory_relations USING btree (tenant_id, from_memory_id, kind);


--
-- Name: idx_memory_relations_from_memory_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_relations_from_memory_id ON public.memory_relations USING btree (from_memory_id);


--
-- Name: idx_memory_relations_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_relations_to ON public.memory_relations USING btree (tenant_id, to_memory_id, kind);


--
-- Name: idx_memory_relations_to_memory_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_relations_to_memory_id ON public.memory_relations USING btree (to_memory_id);


--
-- Name: idx_observations_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_observations_by_subject ON public.observations USING btree (tenant_id, subject_id, recorded_at);


--
-- Name: idx_outbox_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_claimable ON public.outbox USING btree (tenant_id, available_at) WHERE ((completed_at IS NULL) AND (failed_at IS NULL));


--
-- Name: idx_outbox_completed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_completed ON public.outbox USING btree (tenant_id, completed_at, id) WHERE (completed_at IS NOT NULL);


--
-- Name: idx_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_pending ON public.outbox USING btree (tenant_id, kind, available_at) WHERE ((completed_at IS NULL) AND (claimed_at IS NULL));


--
-- Name: idx_recall_usages_memory_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recall_usages_memory_id ON public.recall_usages USING btree (memory_id);


--
-- Name: idx_recall_usages_recall_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recall_usages_recall_id ON public.recall_usages USING btree (recall_id);


--
-- Name: idx_recalls_by_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recalls_by_created ON public.recalls USING btree (tenant_id, created_at, id);


--
-- Name: idx_recalls_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recalls_by_subject ON public.recalls USING btree (tenant_id, subject_id, created_at);


--
-- Name: idx_recalls_digest_band; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recalls_digest_band ON public.recalls USING gin (((index_band -> 'digestBand'::text)) jsonb_path_ops);


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
-- Name: memory_relations memory_relations_from_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_relations
    ADD CONSTRAINT memory_relations_from_memory_id_fkey FOREIGN KEY (from_memory_id) REFERENCES public.memories(id);


--
-- Name: memory_relations memory_relations_to_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_relations
    ADD CONSTRAINT memory_relations_to_memory_id_fkey FOREIGN KEY (to_memory_id) REFERENCES public.memories(id);


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


